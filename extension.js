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
const POPUP_MAX_HEIGHT_FACTOR = 0.7;
const POPUP_MARGIN = 24;
const POPUP_IDLE_TIMEOUT = 15000;
const TITLE_MAX_WIDTH = 420;
const ITEM_SPACING = 2;
const ICON_LABEL_SPACING = 12;

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
    _init(entry, iconSize) {
        super._init({
            style_class: 'z-order-switcher-item',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.window = entry.window;

        if (this.layout_manager)
            this.layout_manager.spacing = ICON_LABEL_SPACING;

        this._icon = new St.Icon({
            style_class: 'z-order-switcher-icon',
            icon_size: iconSize,
            fallback_icon_name: FALLBACK_ICON,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (entry.app && entry.app.get_icon())
            this._icon.gicon = entry.app.get_icon();
        this.add_child(this._icon);

        const labels = new St.BoxLayout({
            style_class: 'z-order-switcher-labels',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._label = new St.Label({
            style_class: 'z-order-switcher-title',
            text: getWindowTitle(entry.window),
            x_expand: true,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._label.clutter_text.line_wrap = false;
        this._label.set_width(TITLE_MAX_WIDTH);
        labels.add_child(this._label);

        const appName = entry.app ? entry.app.get_name() : '';
        if (appName) {
            this._appLabel = new St.Label({
                style_class: 'z-order-switcher-app-name',
                text: appName,
                x_expand: true,
            });
            this._appLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._appLabel.clutter_text.line_wrap = false;
            this._appLabel.set_width(TITLE_MAX_WIDTH);
            labels.add_child(this._appLabel);
        }

        this.add_child(labels);
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
            orientation: Clutter.Orientation.VERTICAL,
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
        this._idleTimeoutId = 0;
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
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
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

        Main.uiGroup.add_child(this);
        Main.uiGroup.set_child_above_sibling(this, null);

        this._connectStage();

        this._grab = Main.pushModal(this);
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
        this._resetIdleTimer();

        // The modifier may have been released before the grab was taken, in
        // which case no key release event will ever reach us.
        if (this._modifierMask) {
            const [, , mods] = global.get_pointer();
            if (!(mods & this._modifierMask)) {
                this._finish(this._selectedIndex);
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
        this._resetIdleTimer();
        this._select(delta);
    }

    _collectEntries() {
        const workspace = this._settings.get_boolean('current-workspace-only')
            ? global.workspace_manager.get_active_workspace()
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
            if (!window.get_compositor_private())
                continue;

            entries.push({window, app: getWindowApp(window)});
        }

        return entries;
    }

    _buildItems() {
        const iconSize = this._settings.get_int('icon-size');

        for (const entry of this._entries) {
            const item = new SwitcherItem(entry, iconSize);
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
        this.ensure_style();

        const focused = global.display.get_focus_window();
        let monitorIndex = Main.layoutManager.primaryIndex;
        if (focused)
            monitorIndex = focused.get_monitor();
        monitorIndex = clamp(monitorIndex, 0, Main.layoutManager.monitors.length - 1);

        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        const [, naturalWidth] = this.get_preferred_width(-1);
        let [, naturalHeight] = this.get_preferred_height(naturalWidth);

        const maxHeight = Math.round(workArea.height * POPUP_MAX_HEIGHT_FACTOR);
        if (naturalHeight > maxHeight) {
            naturalHeight = maxHeight;
            this._scrollView.set_height(maxHeight);
        }

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

        const vadjustment = this._scrollView.get_vadjustment();
        if (!vadjustment || !vadjustment.page_size)
            return;

        const top = item.y;
        const bottom = item.y + item.height;

        if (top < vadjustment.value)
            vadjustment.set_value(top);
        else if (bottom > vadjustment.value + vadjustment.page_size)
            vadjustment.set_value(bottom - vadjustment.page_size);
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

    _resetIdleTimer() {
        if (this._idleTimeoutId)
            GLib.source_remove(this._idleTimeoutId);

        // Safety net: never keep the modal grab (and therefore the keyboard
        // of the whole session) forever, no matter what happens to key events.
        this._idleTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POPUP_IDLE_TIMEOUT, () => {
            this._idleTimeoutId = 0;
            this._finish(this._selectedIndex);
            return GLib.SOURCE_REMOVE;
        });
    }

    _keyPressHandler(event) {
        if (this._closing)
            return Clutter.EVENT_STOP;

        this._resetIdleTimer();

        if (event.get_time() <= this._minEventTime)
            return Clutter.EVENT_PROPAGATE;

        switch (event.get_key_symbol()) {
        case Clutter.KEY_Tab:
        case Clutter.KEY_KP_Tab:
        case Clutter.KEY_Up:
        case Clutter.KEY_Right:
        case Clutter.KEY_Page_Up:
            this._select(1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_ISO_Left_Tab:
        case Clutter.KEY_Down:
        case Clutter.KEY_Left:
        case Clutter.KEY_Page_Down:
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

        this._resetIdleTimer();

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

        if (this._idleTimeoutId) {
            GLib.source_remove(this._idleTimeoutId);
            this._idleTimeoutId = 0;
        }

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
        this._settings = this.getSettings();

        // The shell installs the stock switcher through the same API, so its
        // handler has to be put back when this extension goes away.
        this._defaultHandler = typeof Main.wm._startSwitcher === 'function'
            ? Main.wm._startSwitcher.bind(Main.wm)
            : null;

        for (const [name, direction] of KEYBINDINGS) {
            Main.wm.setCustomKeybindingHandler(
                name,
                ACTION_MODES,
                (display, window, event) => this._onKeybinding(direction, event),
                Meta.KeyBindingFlags.NONE);
        }
    }

    disable() {
        for (const [name] of KEYBINDINGS) {
            const handler = this._defaultHandler;
            Main.wm.setCustomKeybindingHandler(
                name,
                ACTION_MODES,
                handler ? handler : () => {},
                Meta.KeyBindingFlags.NONE);
        }

        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }

        this._defaultHandler = null;
        this._settings = null;
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

        if (!popup.showSwitcher(direction, mask)) {
            popup.destroy();
            this._popup = null;
        }
    }
}