/**
 * Multi-Tag Character Extension for SillyTavern
 * Allows selecting multiple characters and assigning/removing tags in bulk.
 */

import { getContext, extension_settings } from '../../../extensions.js';
import { characters, saveSettingsDebounced, printCharactersDebounced } from '../../../../script.js';
import { tags, tag_map } from '../../../tags.js';

export const extensionName = "multi-tag";
const CHARACTERS_PER_PAGE = 24;

const state = {
    selectedCharacterAvatars: new Set(),
    selectedTagIds: new Set(),
    currentCharacterPage: 1,
};

// Empty stubs for SillyTavern settings manager compatibility
export async function loadSettings() {}
export async function updateSettingsUI() {}
export function addSettingsEventListeners() {}

/**
 * Standard RFC 4122 compliant UUID v4 generator
 */
function uuidv4() {
    return ([1e7]+-1e3+-4e3+-8e3+-11e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

/**
 * Escapes HTML characters to prevent XSS
 */
function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Computes how many characters are tagged with a specific tag ID
 */
function getTagCount(tagId) {
    let count = 0;
    for (const key in tag_map) {
        if (Array.isArray(tag_map[key]) && tag_map[key].includes(tagId)) {
            count++;
        }
    }
    return count;
}

/**
 * Parses SillyTavern character date metadata across common field/format variants.
 */
function parseCharacterDate(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.getTime();

    if (typeof value === 'string') {
        const timestamp = Date.parse(value);
        if (!Number.isNaN(timestamp)) return timestamp;

        const stDateMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})\s*@\s*(\d{1,2})h\s*(\d{1,2})m\s*(\d{1,2})s(?:\s*(\d{1,3})ms)?/);
        if (stDateMatch) {
            const [, year, month, day, hour, minute, second, ms = '0'] = stDateMatch;
            return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(ms)).getTime();
        }
    }

    return 0;
}

function getCharacterTimestamp(char) {
    const possibleDates = [
        char?.create_date,
        char?.date_added,
        char?.date_created,
        char?.data?.create_date,
        char?.data?.date_added,
        char?.data?.date_created,
        char?.data?.extensions?.create_date,
        char?.data?.extensions?.date_added,
    ];

    for (const value of possibleDates) {
        const timestamp = parseCharacterDate(value);
        if (timestamp) return timestamp;
    }

    return 0;
}

function getSortedCharacters(sortMode) {
    return characters
        .map((char, originalIndex) => ({ char, originalIndex }))
        .sort((a, b) => {
            if (sortMode === 'newest') {
                const dateDiff = getCharacterTimestamp(b.char) - getCharacterTimestamp(a.char);
                if (dateDiff !== 0) return dateDiff;
                return b.originalIndex - a.originalIndex;
            }

            return (a.char?.name || '').localeCompare(b.char?.name || '');
        });
}

function getFilteredCharacters(modal) {
    const query = modal.querySelector('#mt-char-search').value.toLowerCase().trim();
    const sortMode = modal.querySelector('#mt-char-sort')?.value || 'az';

    return getSortedCharacters(sortMode).filter(({ char }) =>
        (char?.name || '').toLowerCase().includes(query)
    );
}

function getCharacterTotalPages(count) {
    return Math.max(1, Math.ceil(count / CHARACTERS_PER_PAGE));
}

/**
 * Creates the modal markup and appends it to the DOM if not present
 */
function createModal() {
    if (document.getElementById('mt-modal')) return;

    const modalHtml = `
        <div id="mt-modal" class="mt-modal-container">
            <div class="mt-modal-backdrop"></div>
            <div class="mt-modal-card">
                <div class="mt-modal-header">
                    <h2>Bulk Tag Characters</h2>
                    <button class="mt-close-btn">&times;</button>
                </div>
                <div class="mt-modal-body">
                    <!-- Left Column: Characters -->
                    <div class="mt-column">
                        <div class="mt-column-header">
                            <h3>Characters</h3>
                            <button id="mt-select-all-chars" class="mt-select-all-btn">Select Page</button>
                        </div>
                        <div class="mt-search-wrapper">
                            <input type="text" id="mt-char-search" class="mt-search-input" placeholder="Filter characters...">
                            <select id="mt-char-sort" class="mt-sort-select" title="Sort order">
                                <option value="az">A–Z</option>
                                <option value="newest">Newest</option>
                            </select>
                        </div>
                        <div id="mt-char-list" class="mt-scroll-list mt-char-grid">
                            <!-- Dynamically populated -->
                        </div>
                        <div class="mt-pagination" id="mt-char-pagination">
                            <button id="mt-prev-page" class="mt-page-btn" type="button" aria-label="Previous page">&lsaquo;</button>
                            <span id="mt-page-status" class="mt-page-status">Page 1 of 1</span>
                            <button id="mt-next-page" class="mt-page-btn" type="button" aria-label="Next page">&rsaquo;</button>
                        </div>
                    </div>

                    <!-- Right Column: Tags -->
                    <div class="mt-column">
                        <div class="mt-column-header">
                            <h3>Tags</h3>
                            <button id="mt-select-all-tags" class="mt-select-all-btn">Select All</button>
                        </div>
                        <div class="mt-search-wrapper">
                            <input type="text" id="mt-tag-search" class="mt-search-input" placeholder="Filter tags...">
                        </div>
                        <div id="mt-tag-list" class="mt-scroll-list">
                            <!-- Dynamically populated -->
                        </div>
                        <div class="mt-tag-creator">
                            <input type="text" id="mt-new-tag-input" class="mt-creator-input" placeholder="Create new tag name...">
                            <button id="mt-create-tag-btn" class="mt-creator-btn">Add</button>
                        </div>
                    </div>
                </div>
                <div class="mt-modal-footer">
                    <button id="mt-close-footer-btn" class="mt-btn mt-btn-secondary">Close</button>
                    <button id="mt-remove-tags-btn" class="mt-btn mt-btn-danger">
                        <i class="fa-solid fa-tags"></i> Remove Tags
                    </button>
                    <button id="mt-apply-tags-btn" class="mt-btn mt-btn-primary">
                        <i class="fa-solid fa-tags"></i> Apply Tags
                    </button>
                </div>
            </div>
        </div>
    `;

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = modalHtml;
    document.body.appendChild(tempDiv.firstElementChild);

    // Event listeners
    const modal = document.getElementById('mt-modal');
    modal.querySelector('.mt-close-btn').addEventListener('click', closeModal);
    modal.querySelector('#mt-close-footer-btn').addEventListener('click', closeModal);
    modal.querySelector('.mt-modal-backdrop').addEventListener('click', closeModal);

    modal.querySelector('#mt-select-all-chars').addEventListener('click', toggleSelectAllCharacters);
    modal.querySelector('#mt-select-all-tags').addEventListener('click', toggleSelectAllTags);

    modal.querySelector('#mt-char-search').addEventListener('input', filterCharacters);
    modal.querySelector('#mt-char-sort').addEventListener('change', () => {
        state.currentCharacterPage = 1;
        renderModalLists();
    });
    modal.querySelector('#mt-prev-page').addEventListener('click', () => changeCharacterPage(-1));
    modal.querySelector('#mt-next-page').addEventListener('click', () => changeCharacterPage(1));
    modal.querySelector('#mt-tag-search').addEventListener('input', filterTags);

    modal.querySelector('#mt-create-tag-btn').addEventListener('click', createNewTag);
    modal.querySelector('#mt-new-tag-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') createNewTag();
    });

    modal.querySelector('#mt-apply-tags-btn').addEventListener('click', applyTags);
    modal.querySelector('#mt-remove-tags-btn').addEventListener('click', removeTags);
}

/**
 * Open the bulk tagging modal
 */
function openModal() {
    createModal();

    // Clear search fields & selections
    const modal = document.getElementById('mt-modal');
    modal.querySelector('#mt-char-search').value = '';
    modal.querySelector('#mt-tag-search').value = '';
    modal.querySelector('#mt-new-tag-input').value = '';
    modal.querySelector('#mt-char-sort').value = 'az';
    state.selectedCharacterAvatars.clear();
    state.selectedTagIds.clear();
    state.currentCharacterPage = 1;
    
    // Reset Select All button labels
    modal.querySelector('#mt-select-all-chars').textContent = 'Select Page';
    modal.querySelector('#mt-select-all-tags').textContent = 'Select All';

    renderModalLists();
    modal.classList.add('active');
}

/**
 * Close the bulk tagging modal
 */
function closeModal() {
    const modal = document.getElementById('mt-modal');
    if (modal) {
        modal.classList.remove('active');
    }
}

/**
 * Renders lists of characters and tags in the modal
 */
function renderModalLists() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    // 1. Populate Characters
    const charList = modal.querySelector('#mt-char-list');
    charList.innerHTML = '';
    const filteredChars = getFilteredCharacters(modal);
    const totalPages = getCharacterTotalPages(filteredChars.length);
    state.currentCharacterPage = Math.min(Math.max(state.currentCharacterPage, 1), totalPages);

    const pageStart = (state.currentCharacterPage - 1) * CHARACTERS_PER_PAGE;
    const pageChars = filteredChars.slice(pageStart, pageStart + CHARACTERS_PER_PAGE);

    if (pageChars.length === 0) {
        charList.innerHTML = '<div class="mt-empty-state">No characters found.</div>';
    }

    pageChars.forEach(({ char, originalIndex }) => {
        const avatarUrl = char.avatar ? `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}` : '/img/default-avatar.png';
        const card = document.createElement('div');
        card.className = 'mt-char-card';
        if (state.selectedCharacterAvatars.has(char.avatar)) card.classList.add('selected');
        card.setAttribute('data-index', originalIndex);
        card.setAttribute('data-avatar', char.avatar);
        card.innerHTML = `
            <div class="mt-char-badge"></div>
            <img class="mt-char-avatar" src="${avatarUrl}" onerror="this.src='/img/default-avatar.png'" alt="${escapeHtml(char.name)}">
            <div class="mt-char-name">${escapeHtml(char.name)}</div>
        `;
        card.addEventListener('click', () => {
            card.classList.toggle('selected');
            if (card.classList.contains('selected')) {
                state.selectedCharacterAvatars.add(char.avatar);
            } else {
                state.selectedCharacterAvatars.delete(char.avatar);
            }
            updateSelectAllButtonsState();
        });
        charList.appendChild(card);
    });

    updatePaginationControls(filteredChars.length, totalPages);

    // 2. Populate Tags
    const tagList = modal.querySelector('#mt-tag-list');
    tagList.innerHTML = '';

    // Sort tags alphabetically by default
    const sortedTags = [...tags].sort((a, b) => a.name.localeCompare(b.name));
    
    sortedTags.forEach(tag => {
        const count = getTagCount(tag.id);
        const card = document.createElement('div');
        card.className = 'mt-tag-card';
        if (state.selectedTagIds.has(tag.id)) card.classList.add('selected');
        card.setAttribute('data-id', tag.id);
        const color = tag.color || 'rgba(99, 102, 241, 0.4)';
        card.innerHTML = `
            <div class="mt-tag-color-indicator" style="background-color: ${color}"></div>
            <div class="mt-tag-name">${escapeHtml(tag.name)}</div>
            <div class="mt-tag-count">${count}</div>
            <div class="mt-tag-checkbox"></div>
        `;
        card.addEventListener('click', () => {
            card.classList.toggle('selected');
            if (card.classList.contains('selected')) {
                state.selectedTagIds.add(tag.id);
            } else {
                state.selectedTagIds.delete(tag.id);
            }
            updateSelectAllButtonsState();
        });
        tagList.appendChild(card);
    });

    filterTags();
    updateSelectAllButtonsState();
}

/**
 * Filter character cards in UI based on search query
 */
function filterCharacters() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;
    state.currentCharacterPage = 1;
    renderModalLists();
}

function changeCharacterPage(direction) {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    const totalPages = getCharacterTotalPages(getFilteredCharacters(modal).length);
    const nextPage = Math.min(Math.max(state.currentCharacterPage + direction, 1), totalPages);
    if (nextPage === state.currentCharacterPage) return;

    state.currentCharacterPage = nextPage;
    renderModalLists();
}

function updatePaginationControls(totalCharacters, totalPages) {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    const prevBtn = modal.querySelector('#mt-prev-page');
    const nextBtn = modal.querySelector('#mt-next-page');
    const status = modal.querySelector('#mt-page-status');
    const pageStart = totalCharacters === 0 ? 0 : (state.currentCharacterPage - 1) * CHARACTERS_PER_PAGE + 1;
    const pageEnd = Math.min(state.currentCharacterPage * CHARACTERS_PER_PAGE, totalCharacters);

    prevBtn.disabled = state.currentCharacterPage <= 1;
    nextBtn.disabled = state.currentCharacterPage >= totalPages;
    status.textContent = totalCharacters === 0
        ? 'No characters'
        : `${pageStart}-${pageEnd} of ${totalCharacters}`;
}

/**
 * Filter tag cards in UI based on search query
 */
function filterTags() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;
    const query = modal.querySelector('#mt-tag-search').value.toLowerCase().trim();
    const cards = modal.querySelectorAll('.mt-tag-card');

    cards.forEach(card => {
        const name = card.querySelector('.mt-tag-name').textContent.toLowerCase();
        const isMatch = name.includes(query);
        card.style.setProperty('display', isMatch ? '' : 'none', 'important');
    });

    updateSelectAllButtonsState();
}

/**
 * Toggles selection of all visible characters
 */
function toggleSelectAllCharacters() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    const btn = modal.querySelector('#mt-select-all-chars');
    const visibleCards = Array.from(modal.querySelectorAll('.mt-char-card')).filter(card => card.style.display !== 'none');
    const allSelected = visibleCards.length > 0 && visibleCards.every(card => card.classList.contains('selected'));

    visibleCards.forEach(card => {
        const avatar = card.getAttribute('data-avatar');
        if (allSelected) {
            card.classList.remove('selected');
            state.selectedCharacterAvatars.delete(avatar);
        } else {
            card.classList.add('selected');
            state.selectedCharacterAvatars.add(avatar);
        }
    });

    btn.textContent = allSelected ? 'Select Page' : 'Deselect Page';
}

/**
 * Toggles selection of all visible tags
 */
function toggleSelectAllTags() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    const btn = modal.querySelector('#mt-select-all-tags');
    const visibleCards = Array.from(modal.querySelectorAll('.mt-tag-card')).filter(card => card.style.display !== 'none');
    const allSelected = visibleCards.length > 0 && visibleCards.every(card => card.classList.contains('selected'));

    visibleCards.forEach(card => {
        const id = card.getAttribute('data-id');
        if (allSelected) {
            card.classList.remove('selected');
            state.selectedTagIds.delete(id);
        } else {
            card.classList.add('selected');
            state.selectedTagIds.add(id);
        }
    });

    btn.textContent = allSelected ? 'Select All' : 'Deselect All';
}

/**
 * Updates Select All / Deselect All button text based on card states
 */
function updateSelectAllButtonsState() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    // Characters
    const charBtn = modal.querySelector('#mt-select-all-chars');
    const visibleChars = Array.from(modal.querySelectorAll('.mt-char-card')).filter(card => card.style.display !== 'none');
    const allCharsSelected = visibleChars.length > 0 && visibleChars.every(card => card.classList.contains('selected'));
    charBtn.textContent = allCharsSelected ? 'Deselect Page' : 'Select Page';

    // Tags
    const tagBtn = modal.querySelector('#mt-select-all-tags');
    const visibleTags = Array.from(modal.querySelectorAll('.mt-tag-card')).filter(card => card.style.display !== 'none');
    const allTagsSelected = visibleTags.length > 0 && visibleTags.every(card => card.classList.contains('selected'));
    tagBtn.textContent = allTagsSelected ? 'Deselect All' : 'Select All';
}

/**
 * Creates a brand new tag dynamically
 */
function createNewTag() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    const input = modal.querySelector('#mt-new-tag-input');
    const tagName = input.value.trim();
    if (!tagName) return;

    // Validate if it already exists (case-insensitive check)
    const existingTag = tags.find(t => t.name.toLowerCase() === tagName.toLowerCase());
    if (existingTag) {
        if (typeof toastr !== 'undefined') {
            toastr.warning(`Tag "${escapeHtml(tagName)}" already exists.`);
        }
        // Select it in the UI
        const tagCard = modal.querySelector(`.mt-tag-card[data-id="${existingTag.id}"]`);
        state.selectedTagIds.add(existingTag.id);
        if (tagCard) {
            tagCard.classList.add('selected');
            tagCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        input.value = '';
        return;
    }

    // Generate random tag color (HSL for nice aesthetic saturation)
    const hue = Math.floor(Math.random() * 360);
    const color = `hsla(${hue}, 70%, 55%, 0.4)`;

    // Create the new tag object
    const newTag = {
        id: uuidv4(),
        name: tagName,
        color: color,
        create_date: Date.now()
    };

    tags.push(newTag);
    state.selectedTagIds.add(newTag.id);
    saveSettingsDebounced();

    // Re-render tag lists and automatically select the new tag
    renderModalLists();
    
    const newTagCard = modal.querySelector(`.mt-tag-card[data-id="${newTag.id}"]`);
    if (newTagCard) {
        newTagCard.classList.add('selected');
        newTagCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    if (typeof toastr !== 'undefined') {
        toastr.success(`Tag "${escapeHtml(tagName)}" created successfully.`);
    }

    input.value = '';
    updateSelectAllButtonsState();
}

/**
 * Applies selected tags to selected characters
 */
function applyTags() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    const selectedAvatars = Array.from(state.selectedCharacterAvatars);
    const tagIds = Array.from(state.selectedTagIds);

    if (selectedAvatars.length === 0) {
        if (typeof toastr !== 'undefined') toastr.error("Please select at least one character.");
        return;
    }

    if (tagIds.length === 0) {
        if (typeof toastr !== 'undefined') toastr.error("Please select at least one tag.");
        return;
    }

    let totalAddedCount = 0;

    selectedAvatars.forEach(avatar => {
        if (!avatar) return;

        tag_map[avatar] = tag_map[avatar] || [];

        tagIds.forEach(id => {
            if (!tag_map[avatar].includes(id)) {
                tag_map[avatar].push(id);
                totalAddedCount++;
            }
        });
    });

    saveSettingsDebounced();
    printCharactersDebounced();

    if (typeof toastr !== 'undefined') {
        toastr.success(`Successfully added tags to ${selectedAvatars.length} characters.`);
    }

    // Refresh display counts without closing the modal
    renderModalLists();
}

/**
 * Removes selected tags from selected characters
 */
function removeTags() {
    const modal = document.getElementById('mt-modal');
    if (!modal) return;

    const selectedAvatars = Array.from(state.selectedCharacterAvatars);
    const tagIds = Array.from(state.selectedTagIds);

    if (selectedAvatars.length === 0) {
        if (typeof toastr !== 'undefined') toastr.error("Please select at least one character.");
        return;
    }

    if (tagIds.length === 0) {
        if (typeof toastr !== 'undefined') toastr.error("Please select at least one tag.");
        return;
    }

    let totalRemovedCount = 0;

    selectedAvatars.forEach(avatar => {
        if (!avatar || !tag_map[avatar]) return;

        const initialLength = tag_map[avatar].length;
        tag_map[avatar] = tag_map[avatar].filter(id => !tagIds.includes(id));
        totalRemovedCount += (initialLength - tag_map[avatar].length);
    });

    saveSettingsDebounced();
    printCharactersDebounced();

    if (typeof toastr !== 'undefined') {
        toastr.success(`Successfully removed tags from ${selectedAvatars.length} characters.`);
    }

    // Refresh display counts
    renderModalLists();
}

/**
 * Renders the extension block inside SillyTavern's Extensions settings panel
 */
export async function loadSettingsPanel() {
    const containerId = `extension_settings_${extensionName}`;
    let container = document.getElementById(containerId);
    const parentContainer = document.getElementById('extensions_settings');

    if (!container && parentContainer) {
        container = document.createElement('div');
        container.id = containerId;
        parentContainer.appendChild(container);
    }

    if (container) {
        container.innerHTML = `
            <div class="multi-tag-settings">
                <h4>Multi-Tag Character Tool</h4>
                <p>Select multiple characters at once and apply or remove tags in bulk.</p>
                <button id="mt-open-tool-btn" class="menu_button mt-open-btn">Open Bulk Tagging Tool</button>
            </div>
        `;

        document.getElementById('mt-open-tool-btn').addEventListener('click', () => {
            openModal();
        });
    }
}

// document.ready entry point
$(document).ready(async function () {
    // Render the settings button after a short delay to ensure SillyTavern's settings panel exists
    setTimeout(() => {
        loadSettingsPanel();
    }, 1000);
});
