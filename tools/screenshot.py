#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Z-Order Alt-Tab contributors
#
# SPDX-License-Identifier: GPL-2.0-or-later
"""Take a screenshot after a delay, through the XDG desktop portal.

The switcher forwards PrintScreen to the shell's screenshot UI, but this
helper is still handy for delayed or scripted captures. Start this script
first, then hold Alt+Tab and press Tab a few times; the screenshot is taken
while the switcher is on screen.

Usage:
    tools/screenshot.py --delay 5 --output ~/Pictures/switcher.png

Requires python3-gi (shipped with most GNOME systems).
"""

import argparse
import os
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
TIMEOUT_SECONDS = 30


def take_screenshot(delay):
    """Ask the portal for a screenshot after delay seconds; return the URI."""
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    loop = GLib.MainLoop()
    result = {"uri": None, "code": None}

    def on_response(_connection, _sender, _path, _iface, _signal, params):
        code, results = params.unpack()
        result["code"] = code
        result["uri"] = results.get("uri")
        loop.quit()

    bus.signal_subscribe(
        PORTAL, "org.freedesktop.portal.Request", "Response",
        None, None, Gio.DBusSignalFlags.NONE, on_response,
    )

    def request():
        try:
            reply = bus.call_sync(
                PORTAL, PORTAL_PATH,
                "org.freedesktop.portal.Screenshot", "Screenshot",
                GLib.Variant("(sa{sv})", ("", {"interactive": GLib.Variant("b", False)})),
                GLib.VariantType.new("(o)"),
                Gio.DBusCallFlags.NONE, -1, None,
            )
            print(f"taking the screenshot in {delay}s (request {reply.unpack()[0]})")
        except Exception as error:  # noqa: BLE001
            print(f"could not ask the portal for a screenshot: {error}", file=sys.stderr)
            loop.quit()
        return GLib.SOURCE_REMOVE

    def on_timeout():
        if result["code"] is None:
            print("timed out waiting for the screenshot", file=sys.stderr)
        loop.quit()
        return GLib.SOURCE_REMOVE

    GLib.timeout_add_seconds(max(1, int(delay)), request)
    GLib.timeout_add_seconds(max(1, int(delay)) + TIMEOUT_SECONDS, on_timeout)

    loop.run()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--delay", type=float, default=5,
                        help="seconds to wait before capturing (default: 5)")
    parser.add_argument("--output", default="switcher.png",
                        help="where to save the PNG (default: switcher.png)")
    args = parser.parse_args()

    if args.delay < 0:
        parser.error("--delay must not be negative")

    result = take_screenshot(args.delay)
    if result["code"] != 0 or not result["uri"]:
        print("screenshot was cancelled or failed", file=sys.stderr)
        return 1

    output = os.path.abspath(os.path.expanduser(args.output))
    source = Gio.File.new_for_uri(result["uri"])
    target = Gio.File.new_for_path(output)

    try:
        source.copy(target, Gio.FileCopyFlags.OVERWRITE, None, None)
    except Exception as error:  # noqa: BLE001
        print(f"could not save the screenshot: {error}", file=sys.stderr)
        return 1

    # The portal drops its capture in ~/ by default; remove that copy.
    try:
        source.delete(None)
    except Exception:  # noqa: BLE001
        pass

    print(output)
    return 0


if __name__ == "__main__":
    sys.exit(main())