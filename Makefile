# SPDX-FileCopyrightText: 2026 Z-Order Alt-Tab contributors
#
# SPDX-License-Identifier: GPL-2.0-or-later

# The UUID is the single source of truth in metadata.json; change it there.
UUID := $(shell sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' metadata.json)
SCHEMA_ID := org.gnome.shell.extensions.z-order-alt-tab
SCHEMA_XML := schemas/$(SCHEMA_ID).gschema.xml
EXTENSION_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP := build/$(UUID).shell-extension.zip
SOURCES := extension.js prefs.js metadata.json
ASSETS := stylesheet.css LICENSE

.PHONY: all schemas check install uninstall pack release clean

all: check

schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: $(SCHEMA_XML)
	glib-compile-schemas --strict --targetdir=schemas schemas

check: schemas
	python3 tools/check-metadata.py metadata.json
	cp extension.js /tmp/z-order-alt-tab-extension.mjs
	node --check /tmp/z-order-alt-tab-extension.mjs
	cp prefs.js /tmp/z-order-alt-tab-prefs.mjs
	node --check /tmp/z-order-alt-tab-prefs.mjs
	python3 -m py_compile tools/screenshot.py
	@echo "syntax check passed"

install: schemas
	mkdir -p "$(EXTENSION_DIR)/schemas"
	cp -f $(SOURCES) $(ASSETS) "$(EXTENSION_DIR)/"
	cp -f $(SCHEMA_XML) schemas/gschemas.compiled "$(EXTENSION_DIR)/schemas/"
	@echo "installed to $(EXTENSION_DIR)"
	@echo "then run: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf "$(EXTENSION_DIR)"

# Contents land at the root of the archive, as required by extensions.gnome.org.
# Note: gnome-extensions pack (shell 48) does not add schemas/gschemas.compiled,
# so the bundle is assembled here and verified instead.
pack: schemas
	mkdir -p build
	rm -f "$(ZIP)"
	zip -qr "$(ZIP)" $(SOURCES) $(ASSETS) schemas
	@unzip -Z1 "$(ZIP)" | grep -qx 'metadata.json' || { echo "ERROR: metadata.json is not at the archive root" >&2; exit 1; }
	@unzip -Z1 "$(ZIP)" | grep -qx 'schemas/gschemas.compiled' || { echo "ERROR: schemas/gschemas.compiled is missing" >&2; exit 1; }
	@unzip -l "$(ZIP)"

release: check pack
	@echo
	@echo "Release checklist:"
	@echo "  1. metadata.json shell-version must contain the current GNOME release"
	@echo "  2. git tag -a v$$(date +%Y%m%d) -m \"release\" && git push --tags"
	@echo "  3. upload $(ZIP) on https://extensions.gnome.org (Upload Extension)"

clean:
	rm -rf build schemas/gschemas.compiled

include $(wildcard *.mk)