// SPDX-FileCopyrightText: 2026 Z-Order Alt-Tab contributors
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ZOrderAltTabPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.set_default_size(520, 320);

        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const behavior = new Adw.PreferencesGroup({
            title: _('Switching'),
            description: _('Controls which windows the stacking order covers.'),
        });
        page.add(behavior);

        const workspaceRow = new Adw.SwitchRow({
            title: _('Current workspace only'),
            subtitle: _('Leave this off to walk the stack of every workspace.'),
        });
        settings.bind('current-workspace-only', workspaceRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behavior.add(workspaceRow);

        const wrapRow = new Adw.SwitchRow({
            title: _('Wrap around'),
            subtitle: _('Continue at the other end of the stack.'),
        });
        settings.bind('wrap-around', wrapRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behavior.add(wrapRow);

        const appearance = new Adw.PreferencesGroup({
            title: _('Appearance'),
        });
        page.add(appearance);

        const iconRow = new Adw.SpinRow({
            title: _('Icon size'),
            subtitle: _('Size of the application icons in pixels.'),
            adjustment: new Gtk.Adjustment({
                lower: 16,
                upper: 64,
                step_increment: 4,
                page_increment: 8,
                value: settings.get_int('icon-size'),
            }),
        });
        settings.bind('icon-size', iconRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        appearance.add(iconRow);

        const previewRow = new Adw.SpinRow({
            title: _('Preview size (%)'),
            subtitle: _('Scale of the window previews in the switcher.'),
            adjustment: new Gtk.Adjustment({
                lower: 75,
                upper: 200,
                step_increment: 5,
                page_increment: 25,
                value: settings.get_int('preview-size'),
            }),
        });
        settings.bind('preview-size', previewRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        appearance.add(previewRow);
    }
}