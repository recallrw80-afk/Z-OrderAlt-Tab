// SPDX-FileCopyrightText: 2026 Z-Order Alt-Tab contributors
//
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Z-Order Alt-Tab replaces the Alt-Tab window switcher with one that walks
// the *stacking* order instead of the most-recently-used order.
//
// The switcher lists every window ordered by its stacking position, the
// topmost window first. Each Tab press moves one window further down the
// stack, and the window that ends up selected is activated, which raises it
// to the top. Starting from
//
//     a1  a2  b1  b2  c1  c2      (a1 is at the bottom, c2 on top)
//
// activating a1 gives
//
//     a2  b1  b2  c1  c2  a1
//
// and activating b2 next gives
//
//     a2  b1  c1  c2  a1  b2

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// Depending on the distribution, Alt-Tab is bound either to the application
// switcher or to the window switcher, so both pairs are taken over.
const KEYBINDINGS = [
    ['switch-applications', 1],
    ['switch-applications-backward', -1],
    ['switch-windows', 1],
    ['switch-windows-backward', -1],
];
const ACTION_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

const POPUP_SHOW_DELAY = 150;
const POPUP_FADE_TIME = 120;
const POPUP_TOP_FACTOR = 0.24;
const POPUP_MAX_WIDTH_FACTOR = 0.9;
const POPUP_MARGIN = 24;
const ITEM_SPACING = 8;

const THUMB_WIDTH = 176;
const THUMB_HEIGHT = 110;
const CAPTION_SPACING = 6;

const FALLBACK_ICON = 'application-x-executable';

const MODIFIER_KEYSYMS = new Set([
    Clutter.KEY_Alt_L,
    Clutter.KEY_Alt_R,
    Clutter.KEY_Meta_L,
    Clutter.KEY_Meta_R,
    Clutter.KEY_Super_L,
    Clutter.KEY_Super_R,
    Clutter.KEY_Control_L,
    Clutter.KEY_Control_R,
]);

const PRIMARY_MODIFIERS = [
    Clutter.ModifierType.MOD1_MASK,
    Clutter.ModifierType.SUPER_MASK,
    Clutter.ModifierType.CONTROL_MASK,
];

/**
 * The modifier the switcher was summoned with, so that releasing it commits.
 *
 * @param {number} mask Clutter modifier state
 * @returns {number}
 */
function primaryModifier(mask) {
    for (const modifier of PRIMARY_MODIFIERS) {
        if (mask & modifier)
            return modifier;
    }
    return 0;
}

/**
 * The UI group moved between shell versions; fall back to the layout
 * manager's group when Main.uiGroup is gone.
 *
 * @returns {Clutter.Actor|null}
 */
function getUiGroup() {
    if (Main.uiGroup)
        return Main.uiGroup;
    if (Main.layoutManager && Main.layoutManager.uiGroup)
        return Main.layoutManager.uiGroup;
    return null;
}

/**
 * @returns {Meta.Workspace|null}
 */
function getActiveWorkspace() {
    try {
        if (global.workspace_manager)
            return global.workspace_manager.get_active_workspace();
        if (typeof global.display.get_workspace_manager === 'function')
            return global.display.get_workspace_manager().get_active_workspace();
    } catch (e) {
        logError(e, 'Z-Order Alt-Tab: cannot read the active workspace');
    }
    return null;
}

/**
 * Frame geometry of a window. get_frame_rect() was replaced by
 * get_frame_bounds() in newer mutter versions.
 *
 * @param {Meta.Window} window
 * @returns {{width: number, height: number}|null}
 */
function getWindowRect(window) {
    for (const method of ['get_frame_rect', 'get_frame_bounds']) {
        if (typeof window[method] !== 'function')
            continue;
        try {
            const rect = window[method]();
            if (rect && rect.width > 0 && rect.height > 0)
                return rect;
        } catch (e) {
            // Try the next accessor.
        }
    }
    return null;
}

/**
 * @param {Meta.Window|null} window
 * @returns {number} monitor index, or -1 when unknown
 */
function getWindowMonitor(window) {
    if (!window || typeof window.get_monitor !== 'function')
        return -1;
    try {
        return window.get_monitor();
    } catch (e) {
        return -1;
    }
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getWindowApp(window) {
    try {
        return Shell.WindowTracker.get_default().get_window_app(window);
    } catch (e) {
        return null;
    }
}

function getWindowTitle(window) {
    const title = window.get_title();
    if (title && title.trim().length > 0)
        return title;

    const app = getWindowApp(window);
    return app ? app.get_name() : 'Untitled window';
}

function activateWindow(window, timestamp) {
    if (!window)
        return;

    try {
        if (typeof Main.activateWindow === 'function')
            Main.activateWindow(window, timestamp);
        else
            window.activate(timestamp);
    } catch (e) {
        logError(e, 'Z-Order Alt-Tab: failed to activate window');
    }
}

/**
 * One row of the switcher: application icon, window title and app name.
 */
const SwitcherItem = GObject.registerClass(
class SwitcherItem extends St.BoxLayout {
    _init(entry, iconSize, thumbWidth, thumbHeight) {
        super._init({
            style_class: 'z-order-switcher-item',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.START,
        });

        this._thumbBox = new St.Widget({
            style_class: 'z-order-switcher-thumb',
            width: thumbWidth,
            height: thumbHeight,
            layout_manager: new Clutter.BinLayout(),
        });

        const preview = this._createPreview(entry, iconSize, thumbWidth, thumbHeight);
        preview.x_align = Clutter.ActorAlign.CENTER;
        preview.y_align = Clutter.ActorAlign.CENTER;
        this._thumbBox.add_child(preview);
        this.add_child(this._thumbBox);

        const caption = new St.BoxLayout({
            style_class: 'z-order-switcher-caption',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (caption.layout_manager)
            caption.layout_manager.spacing = CAPTION_SPACING;

        const icon = new St.Icon({
            style_class: 'z-order-switcher-app-icon',
            icon_size: iconSize,
            fallback_icon_name: FALLBACK_ICON,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (entry.app && entry.app.get_icon())
            icon.gicon = entry.app.get_icon();
        caption.add_child(icon);

        this._label = new St.Label({
            style_class: 'z-order-switcher-title',
            text: getWindowTitle(entry.window),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const labelText = this._label.clutter_text;
        if (labelText) {
            labelText.ellipsize = Pango.EllipsizeMode.END;
            labelText.line_wrap = false;
        }
        // Keep the caption as wide as the thumbnail, whatever the icon size.
        this._label.set_width(thumbWidth - iconSize - CAPTION_SPACING);
        caption.add_child(this._label);

        this.add_child(caption);
    }

    /**
     * A live preview of the window, scaled to fit the thumbnail box.
     *
     * @param {object} entry window plus its application
     * @param {number} iconSize application icon size
     * @param {number} thumbWidth thumbnail box width
     * @param {number} thumbHeight thumbnail box height
     * @returns {Clutter.Actor}
     */
    _createPreview(entry, iconSize, thumbWidth, thumbHeight) {
        const windowActor = entry.window.get_compositor_private();

        if (windowActor) {
            try {
                const rect = getWindowRect(entry.window) ?? {width: 16, height: 9};
                const scale = Math.min(thumbWidth / rect.width, thumbHeight / rect.height);

                return new Clutter.Clone({
                    source: windowActor,
                    width: Math.max(1, Math.round(rect.width * scale)),
                    height: Math.max(1, Math.round(rect.height * scale)),
                });
            } catch (e) {
                logError(e, 'Z-Order Alt-Tab: could not build window preview');
            }
        }

        const icon = new St.Icon({
            style_class: 'z-order-switcher-icon',
            icon_size: iconSize,
            fallback_icon_name: FALLBACK_ICON,
        });
        if (entry.app && entry.app.get_icon())
            icon.gicon = entry.app.get_icon();
        return icon;
    }

    setSelected(selected) {
        this.set_style_class_name(selected
            ? 'z-order-switcher-item z-order-switcher-item-selected'
            : 'z-order-switcher-item');
    }
});

/**
 * The switcher: one row per window, ordered like the window stack.
 */
const SwitcherPopup = GObject.registerClass(
class SwitcherPopup extends St.BoxLayout {
    _init(extension) {
        super._init({
            style_class: 'z-order-switcher',
            orientation: Clutter.Orientation.HORIZONTAL,
            reactive: true,
            can_focus: true,
            visible: true,
            opacity: 0,
        });

        this._settings = extension.getSettings();
        this._items = [];
        this._entries = [];          // top -> bottom, like the stack
        this._selectedIndex = -1;
        this._grab = null;
        this._stageHandlers = [];
        this._showTimeoutId = 0;
        this._closing = false;
        this._minEventTime = 0;
        this._modifierMask = 0;

        this._scrollView = new St.ScrollView({
            style_class: 'z-order-switcher-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
        });

        this._itemBox = new St.BoxLayout({
            style_class: 'z-order-switcher-box',
            orientation: Clutter.Orientation.HORIZONTAL,
            y_expand: true,
        });

        if (this._itemBox.layout_manager)
            this._itemBox.layout_manager.spacing = ITEM_SPACING;

        this._scrollView.add_child(this._itemBox);
        this.add_child(this._scrollView);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    /**
     * Pop up the switcher.
     *
     * @param {number} direction 1 to walk down the stack, -1 to walk up
     * @param {number} mask modifier state of the triggering key event
     * @returns {boolean} whether the switcher was shown
     */
    showSwitcher(direction, mask) {
        this._entries = this._collectEntries();
        if (this._entries.length < 2)
            return false;

        this._buildItems();

        // Ignore the key event that triggered us; it may still be delivered
        // to the popup after the grab below is taken.
        this._minEventTime = global.get_current_time();
        this._modifierMask = primaryModifier(mask);

        const uiGroup = getUiGroup();
        if (!uiGroup) {
            console.warn('Z-Order Alt-Tab: no UI group to add the switcher to');
            return false;
        }

        uiGroup.add_child(this);
        uiGroup.set_child_above_sibling(this, null);

        this._connectStage();

        try {
            this._grab = Main.pushModal(this);
        } catch (e) {
            try {
                this._grab = Main.pushModal(this, {
                    timestamp: global.get_current_time(),
                    actionMode: Shell.ActionMode.NORMAL,
                });
            } catch (e2) {
                logError(e2, 'Z-Order Alt-Tab: could not push a modal grab');
                this._grab = null;
            }
        }
        if (!this._grab) {
            console.warn('Z-Order Alt-Tab: could not acquire a modal grab');
        } else if (typeof this._grab.get_seat_state === 'function' &&
            (this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            console.warn('Z-Order Alt-Tab: modal grab has no keyboard state');
            this._popGrab();
            return false;
        }

        this._selectedIndex = this._initialIndex(direction);
        this._syncSelection();
        this._position();
        this.grab_key_focus();

        // The modifier may have been released before the grab was taken, in
        // which case no key release event will ever reach us. Close again
        // without switching anything.
        if (this._modifierMask) {
            const [, , mods] = global.get_pointer();
            if (!(mods & this._modifierMask)) {
                this._finish(null);
                return true;
            }
        }

        // Fast Alt+Tab taps should not flash the popup.
        this._showTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPUP_SHOW_DELAY, () => {
            this._showTimeoutId = 0;
            this._ensureVisible();
            this.ease({
                opacity: 255,
                duration: POPUP_FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    /**
     * Move the selection. Also used when the keybinding fires again while the
     * popup is already up, which happens if the modal grab was not taken.
     *
     * @param {number} delta direction to move in
     */
    select(delta) {
        this._select(delta);
    }

    _collectEntries() {
        const workspace = this._settings.get_boolean('current-workspace-only')
            ? getActiveWorkspace()
            : null;

        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace);
        if (!windows || windows.length === 0)
            return [];

        // sort_windows_by_stacking() returns bottom-to-top order, while the
        // switcher lists the topmost window first.
        let sorted;
        try {
            sorted = global.display.sort_windows_by_stacking(windows).slice().reverse();
        } catch (e) {
            logError(e, 'Z-Order Alt-Tab: could not sort windows by stacking');
            sorted = windows.slice();
        }

        const entries = [];
        for (const window of sorted) {
            if (!window)
                continue;
            if (window.get_window_type() === Meta.WindowType.DESKTOP)
                continue;

            // A window without a compositor actor still belongs in the list;
            // _createPreview() falls back to the application icon.
            entries.push({window, app: getWindowApp(window)});
        }

        return entries;
    }

    _buildItems() {
        const iconSize = this._settings.get_int('icon-size');
        const scale = this._settings.get_int('preview-size') / 100;
        const thumbWidth = Math.round(THUMB_WIDTH * scale);
        const thumbHeight = Math.round(THUMB_HEIGHT * scale);

        for (const entry of this._entries) {
            const item = new SwitcherItem(entry, iconSize, thumbWidth, thumbHeight);
            this._items.push(item);
            this._itemBox.add_child(item);
        }
    }

    _initialIndex(direction) {
        const focused = global.display.get_focus_window();
        let base = this._entries.findIndex(entry => focused && entry.window === focused);

        if (base < 0)
            base = direction > 0 ? -1 : 0;

        return this._wrapIndex(base + direction);
    }

    _wrapIndex(index) {
        const count = this._entries.length;
        if (count === 0)
            return -1;

        if (this._settings.get_boolean('wrap-around'))
            return ((index % count) + count) % count;

        return clamp(index, 0, count - 1);
    }

    _select(delta) {
        if (this._entries.length === 0)
            return;

        const index = this._wrapIndex(this._selectedIndex + delta);
        if (index === this._selectedIndex)
            return;

        this._selectedIndex = index;
        this._syncSelection();
        this._ensureVisible();
    }

    _syncSelection() {
        this._items.forEach((item, index) => {
            item.setSelected(index === this._selectedIndex);
        });
    }

    _position() {
        if (typeof this.ensure_style === 'function')
            this.ensure_style();

        const focused = global.display.get_focus_window();
        let monitorIndex = getWindowMonitor(focused);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        monitorIndex = clamp(monitorIndex, 0, Main.layoutManager.monitors.length - 1);

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const maxWidth = Math.round(workArea.width * POPUP_MAX_WIDTH_FACTOR);

        let [, naturalWidth] = this.get_preferred_width(-1);
        if (naturalWidth > maxWidth) {
            const node = this.get_theme_node();
            const extra =
                node.get_padding(St.Side.LEFT) + node.get_padding(St.Side.RIGHT) +
                node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT);
            this._scrollView.set_width(Math.max(120, maxWidth - extra));
            [, naturalWidth] = this.get_preferred_width(-1);
        }

        const [, naturalHeight] = this.get_preferred_height(-1);

        const x = workArea.x + Math.round((workArea.width - naturalWidth) / 2);
        const y = clamp(
            workArea.y + Math.round(workArea.height * POPUP_TOP_FACTOR),
            workArea.y + POPUP_MARGIN,
            workArea.y + workArea.height - naturalHeight - POPUP_MARGIN);

        this.set_position(
            Math.max(x, workArea.x + POPUP_MARGIN),
            Math.max(y, workArea.y + POPUP_MARGIN));
    }

    _ensureVisible() {
        if (this._closing || this._selectedIndex < 0)
            return;

        const item = this._items[this._selectedIndex];
        if (!item)
            return;

        const hadjustment = this._scrollView.get_hadjustment();
        if (!hadjustment || !hadjustment.page_size)
            return;

        const left = item.x;
        const right = item.x + item.width;

        if (left < hadjustment.value)
            hadjustment.set_value(left);
        else if (right > hadjustment.value + hadjustment.page_size)
            hadjustment.set_value(right - hadjustment.page_size);
    }

    /**
     * While the modal grab is held, key events are routed to the grab actor
     * (this widget) and never reach the stage, so the actor vfuncs handle
     * them. The stage handlers cover the case where no grab was acquired.
     */
    _connectStage() {
        this._stageHandlers.push(
            global.stage.connect('key-press-event', this._onStageKeyPress.bind(this)));
        this._stageHandlers.push(
            global.stage.connect('key-release-event', this._onStageKeyRelease.bind(this)));
    }

    _disconnectStage() {
        for (const id of this._stageHandlers)
            global.stage.disconnect(id);
        this._stageHandlers = [];
    }

    _onStageKeyPress(actor, event) {
        // With a grab in place the events are consumed by the vfuncs.
        if (this._grab)
            return Clutter.EVENT_PROPAGATE;
        return this._keyPressHandler(event);
    }

    _onStageKeyRelease(actor, event) {
        if (this._grab)
            return Clutter.EVENT_PROPAGATE;
        return this._keyReleaseHandler(event);
    }

    vfunc_key_press_event(event) {
        return this._keyPressHandler(event);
    }

    vfunc_key_release_event(event) {
        return this._keyReleaseHandler(event);
    }

    _keyPressHandler(event) {
        if (this._closing)
            return Clutter.EVENT_STOP;

        if (event.get_time() <= this._minEventTime)
            return Clutter.EVENT_PROPAGATE;

        switch (event.get_key_symbol()) {
        case Clutter.KEY_Tab:
        case Clutter.KEY_KP_Tab:
        case Clutter.KEY_Down:
        case Clutter.KEY_Right:
        case Clutter.KEY_Page_Down:
            this._select(1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_ISO_Left_Tab:
        case Clutter.KEY_Up:
        case Clutter.KEY_Left:
        case Clutter.KEY_Page_Up:
            this._select(-1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Escape:
            this._finish(null);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space:
            this._finish(this._selectedIndex);
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    _keyReleaseHandler(event) {
        if (this._closing)
            return Clutter.EVENT_STOP;

        // Releasing the modifier that summoned the switcher commits the
        // selection, just like the built-in Alt-Tab.
        if (MODIFIER_KEYSYMS.has(event.get_key_symbol())) {
            this._finish(this._selectedIndex);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _finish(index) {
        if (this._closing)
            return;

        const entry = index === null ? null : this._entries[index];
        const window = entry ? entry.window : null;

        this._closing = true;
        this._popGrab();
        this._disconnectStage();
        this.destroy();

        if (window)
            activateWindow(window, global.get_current_time());
    }

    _popGrab() {
        if (!this._grab)
            return;

        const grab = this._grab;
        this._grab = null;

        try {
            Main.popModal(grab);
        } catch (e) {
            logError(e, 'Z-Order Alt-Tab: failed to release the modal grab');
        }
    }

    _onDestroy() {
        this._closing = true;

        if (this._showTimeoutId) {
            GLib.source_remove(this._showTimeoutId);
            this._showTimeoutId = 0;
        }

        this._disconnectStage();
        this._popGrab();
        this._items = [];
        this._entries = [];
    }
});

export default class ZOrderAltTabExtension extends Extension {
    enable() {
        this._popup = null;

        // Handler the shell installed for its own switcher. It is used to put
        // the stock behaviour back when this extension is disabled.
        this._defaultHandler = Main.wm && typeof Main.wm._startSwitcher === 'function'
            ? Main.wm._startSwitcher.bind(Main.wm)
            : null;

        for (const [name, direction] of KEYBINDINGS)
            this._installHandler(name, this._makeHandler(direction));
    }

    disable() {
        for (const [name, direction] of KEYBINDINGS)
            this._restoreHandler(name, direction);

        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }

        this._defaultHandler = null;
    }

    _makeHandler(direction) {
        return (display, window, event) => this._onKeybinding(direction, event);
    }

    /**
     * Take over a shell keybinding. The API used for that changed over the
     * supported shell versions, so try them in order.
     *
     * @param {string} name keybinding name
     * @param {Function} handler handler to install
     * @returns {boolean} whether the handler was installed
     */
    _installHandler(name, handler) {
        try {
            if (Main.wm && typeof Main.wm.setCustomKeybindingHandler === 'function') {
                Main.wm.setCustomKeybindingHandler(
                    name, ACTION_MODES, handler, Meta.KeyBindingFlags.NONE);
                return true;
            }
        } catch (e) {
            logError(e, `Z-Order Alt-Tab: could not take over ${name}`);
        }

        try {
            if (typeof Meta.keybindings_set_custom_handler !== 'function')
                return false;

            const installed = Meta.keybindings_set_custom_handler(name, handler);
            if (installed && Main.wm && typeof Main.wm.allowKeybinding === 'function')
                Main.wm.allowKeybinding(name, ACTION_MODES);
            return installed;
        } catch (e) {
            logError(e, `Z-Order Alt-Tab: could not install a handler for ${name}`);
            return false;
        }
    }

    /**
     * Hand a keybinding back to the shell. The stock handler is a private
     * method that may disappear between shell versions, so fall back to a
     * plain MRU switch rather than leaving Alt-Tab dead.
     *
     * @param {string} name keybinding name
     * @param {number} direction 1 or -1
     */
    _restoreHandler(name, direction) {
        const stock = this._defaultHandler ??
            (Main.wm && typeof Main.wm._startAppSwitcher === 'function'
                ? Main.wm._startAppSwitcher.bind(Main.wm)
                : null);

        if (stock) {
            this._installHandler(name, stock);
            return;
        }

        this._installHandler(name, () => this._switchMru(direction));
    }

    /**
     * Emergency replacement for the stock switcher: activate the next or
     * previous window in most-recently-used order.
     *
     * @param {number} direction 1 or -1
     */
    _switchMru(direction) {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, getActiveWorkspace());
        if (!windows || windows.length < 2)
            return;

        const focused = global.display.get_focus_window();
        const focusedIndex = windows.indexOf(focused);
        const current = focusedIndex >= 0
            ? focusedIndex
            : (direction > 0 ? -1 : 0);
        const count = windows.length;
        const next = windows[((current + direction) % count + count) % count];

        activateWindow(next, global.get_current_time());
    }

    _onKeybinding(direction, event) {
        const mask = event && typeof event.get_state === 'function'
            ? event.get_state()
            : 0;

        if (this._popup) {
            // The popup normally owns the keyboard through its modal grab;
            // this path only happens if that grab was refused.
            this._popup.select(direction);
            return;
        }

        const popup = new SwitcherPopup(this);
        popup.connect('destroy', () => {
            if (this._popup === popup)
                this._popup = null;
        });

        this._popup = popup;

        let shown = false;
        try {
            shown = popup.showSwitcher(direction, mask);
        } catch (e) {
            logError(e, 'Z-Order Alt-Tab: failed to show the switcher');
        }

        if (!shown) {
            // destroy() releases the grab and the stage handlers even when
            // showSwitcher() failed halfway through.
            popup.destroy();
            if (this._popup === popup)
                this._popup = null;
        }
    }
}