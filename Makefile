# Z-Order Alt-Tab

UUID := z-order-alt-tab@local
SCHEMA_ID := org.gnome.shell.extensions.z-order-alt-tab
SCHEMA_XML := schemas/$(SCHEMA_ID).gschema.xml
EXTENSION_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP := build/$(UUID).shell-extension.zip
SOURCES := extension.js prefs.js metadata.json stylesheet.css

.PHONY: all schemas check install uninstall pack clean

all: check

schemas: schemas/gschemas.compiled

schemas/gschemas.compiled: $(SCHEMA_XML)
	glib-compile-schemas --strict --targetdir=schemas schemas

check: schemas
	cp extension.js /tmp/z-order-alt-tab-extension.mjs
	node --check /tmp/z-order-alt-tab-extension.mjs
	cp prefs.js /tmp/z-order-alt-tab-prefs.mjs
	node --check /tmp/z-order-alt-tab-prefs.mjs
	@echo "syntax check passed"

install: schemas
	mkdir -p "$(EXTENSION_DIR)/schemas"
	cp -f $(SOURCES) "$(EXTENSION_DIR)/"
	cp -f $(SCHEMA_XML) schemas/gschemas.compiled "$(EXTENSION_DIR)/schemas/"
	@echo "installed to $(EXTENSION_DIR)"
	@echo "then run: gnome-extensions enable $(UUID)"

uninstall:
	rm -rf "$(EXTENSION_DIR)"

pack: schemas
	mkdir -p build
	rm -f "$(ZIP)"
	zip -qr "$(ZIP)" $(SOURCES) schemas
	@echo "packed $(ZIP)"

clean:
	rm -rf build schemas/gschemas.compiled

include $(wildcard *.mk)
