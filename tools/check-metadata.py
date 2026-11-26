#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Z-Order Alt-Tab contributors
#
# SPDX-License-Identifier: GPL-2.0-or-later
"""Validate metadata.json before building or uploading a bundle.

Catches the classic copy/paste accidents: HTML markup or escaped entities in
the name/description (for example after translating the upload page in the
browser), missing fields, or an invalid uuid.
"""

import json
import re
import sys

REQUIRED = ("uuid", "name", "description", "shell-version")
MARKUP_MARKERS = ("<", ">", "&lt;", "&gt;", "&amp;", "&quot;", "&#")


def main(path):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as error:
        print(f"{path}: not valid JSON: {error}", file=sys.stderr)
        return 1

    errors = []

    for key in REQUIRED:
        value = data.get(key)
        if value in (None, "", []):
            errors.append(f"missing or empty field: {key}")

    uuid = data.get("uuid", "")
    if uuid and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*", uuid):
        errors.append(f"uuid does not look like name@domain: {uuid!r}")

    versions = data.get("shell-version")
    if versions is not None and not (isinstance(versions, list) and
                                     all(isinstance(v, str) for v in versions)):
        errors.append("shell-version must be a list of strings")

    for key in ("name", "description"):
        value = data.get(key, "")
        found = [marker for marker in MARKUP_MARKERS if marker in value]
        if found:
            errors.append(f"{key} contains markup/escaped HTML ({', '.join(found)})")

    if errors:
        for error in errors:
            print(f"{path}: {error}", file=sys.stderr)
        return 1

    print(f"{path}: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "metadata.json"))
