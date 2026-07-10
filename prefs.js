import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.service-pauser';
const HELPER_INSTALL_PATH = '/usr/local/bin/service-pauser-helper';
const CONFIG_PATH = '/etc/service-pauser/units.json';
const VALID_ID_RE = /^[A-Za-z0-9_.@:-]+$/;
const VALID_SERVICE_RE = /^[A-Za-z0-9_.@:-]+\.service$/;
const VALID_TIMER_RE = /^[A-Za-z0-9_.@:-]+\.timer$/;

class HelperClient {
    _helperCommand(action) {
        const sudoBin = GLib.find_program_in_path('sudo');
        if (!sudoBin) {
            throw new Error('sudo was not found');
        }

        if (!GLib.file_test(HELPER_INSTALL_PATH, GLib.FileTest.IS_EXECUTABLE)) {
            throw new Error('setup required');
        }

        return [sudoBin, '-n', HELPER_INSTALL_PATH, action];
    }

    run(action, input = null) {
        let argv;
        try {
            argv = this._helperCommand(action);
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise((resolve, reject) => {
            try {
                let flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
                if (input !== null) {
                    flags |= Gio.SubprocessFlags.STDIN_PIPE;
                }

                const proc = new Gio.Subprocess({ argv, flags });
                proc.init(null);
                proc.communicate_utf8_async(input, null, (source, res) => {
                    try {
                        const [, stdout, stderr] = source.communicate_utf8_finish(res);
                        let payload = null;
                        if (stdout?.trim()) {
                            payload = JSON.parse(stdout.trim());
                        }

                        if (source.get_successful() && payload) {
                            resolve(payload);
                            return;
                        }

                        const message = payload?.error || stderr?.trim() || stdout?.trim() || 'Helper command failed';
                        const error = new Error(message);
                        error.payload = payload;
                        reject(error);
                    } catch (error) {
                        reject(error);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }
}

function unitSubtitle(entry, gettext) {
    if (!entry.service) {
        return gettext('No service unit');
    }

    if (entry.timer) {
        return `${entry.service} / ${entry.timer}`;
    }

    return entry.service;
}

function targetSubtitle(entry, gettext) {
    if (!entry.schema || !entry.key) {
        return gettext('No schema/key');
    }

    return `${entry.schema} / ${entry.key}`;
}

const FOLDERSIZE_TARGET_PRESET = {
    id: 'foldersize',
    label: 'Folder size scan',
    schema: 'org.gnome.shell.extensions.foldersize',
    extension_uuid: 'foldersize@yurij.de',
    key: 'auto-scan',
    pause_value: false,
    enabled: true,
    own_toggle_key: 'show-quick-settings',
    install_url: 'https://github.com/shell-extensions/foldersize/releases',
};

// Mirrors extension.js: schemas compiled only inside another extension's
// own directory aren't found by SettingsSchemaSource.get_default(), so fall
// back to the two locations GNOME Shell installs/loads extensions from.
const EXTENSION_SEARCH_DIRS = [
    GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'gnome-shell', 'extensions']),
    '/usr/share/gnome-shell/extensions',
];

function lookupTargetSchema(defaultSource, schemaId, extensionUuid) {
    const direct = defaultSource.lookup(schemaId, true);
    if (direct || !extensionUuid) {
        return direct;
    }

    for (const base of EXTENSION_SEARCH_DIRS) {
        const schemaDir = GLib.build_filenamev([base, extensionUuid, 'schemas']);
        if (!GLib.file_test(schemaDir, GLib.FileTest.IS_DIR)) {
            continue;
        }

        try {
            const layered = Gio.SettingsSchemaSource.new_from_directory(schemaDir, defaultSource, false);
            const schema = layered.lookup(schemaId, true);
            if (schema) {
                return schema;
            }
        } catch (error) {
            logError(error, `Service Pauser: failed to load schema dir ${schemaDir}`);
        }
    }

    return null;
}

export default class ServicePauserPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._ = this.gettext.bind(this);
        this._helper = new HelperClient();
        this._entries = [];
        this._serviceRows = [];
        this._defaultEntries = this._loadDefaultEntries();
        this._defaultsById = new Map(this._defaultEntries.map(entry => [entry.id, entry]));
        this._defaultStatusById = new Map();
        this._targets = [];
        this._targetRows = [];
        this._schemaSource = Gio.SettingsSchemaSource.get_default();

        const settings = this.getSettings(SCHEMA_ID);
        this._settings = settings;
        const page = new Adw.PreferencesPage();
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({ title: this._('General') });
        page.add(generalGroup);

        generalGroup.add(this._switchRow(settings, this._('Show Quick Settings toggle'), 'show-quick-settings'));
        generalGroup.add(this._switchRow(settings, this._('Resume on extension disable'), 'auto-resume-on-disable'));
        generalGroup.add(this._spinRow(settings, this._('Refresh interval (s)'), 'refresh-interval', 2, 300, 1));

        const servicesGroup = new Adw.PreferencesGroup({
            title: this._('Services'),
            description: this._('Edit background maintenance services managed by Service Pauser.'),
        });
        page.add(servicesGroup);

        this._messageRow = new Adw.ActionRow({
            title: this._('Loading services'),
            subtitle: CONFIG_PATH,
        });
        servicesGroup.add(this._messageRow);
        servicesGroup.add(this._controlRow());

        this._servicesListGroup = new Adw.PreferencesGroup({ title: this._('Configured services') });
        page.add(this._servicesListGroup);

        const targetsGroup = new Adw.PreferencesGroup({
            title: this._('GSettings switches'),
            description: this._('Toggle other extensions’ GSettings booleans (like a scan/auto-run switch) together with the pause button. Applied directly, no privileged helper needed.'),
        });
        page.add(targetsGroup);

        this._targetsMessageRow = new Adw.ActionRow({
            title: this._('GSettings switches'),
            subtitle: 'gsettings-targets',
        });
        targetsGroup.add(this._targetsMessageRow);
        targetsGroup.add(this._targetsControlRow());

        this._targetsListGroup = new Adw.PreferencesGroup({ title: this._('Configured switches') });
        page.add(this._targetsListGroup);

        const pathsGroup = new Adw.PreferencesGroup({ title: this._('System files') });
        page.add(pathsGroup);
        pathsGroup.add(this._infoRow(this._('Helper'), HELPER_INSTALL_PATH));
        pathsGroup.add(this._infoRow(this._('Services'), CONFIG_PATH));

        window.set_default_size(680, 620);
        this._loadConfig();
        this._loadTargets();
    }

    _controlRow() {
        const row = new Adw.ActionRow({
            title: this._('Service configuration'),
            subtitle: this._('Changes are written through the privileged helper.'),
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        this._addButton = this._iconButton('list-add-symbolic', this._('Add service'), () => this._addEntry());
        this._restoreButton = this._iconButton('document-revert-symbolic', this._('Restore built-in catalog'), () => this._restoreCatalog());
        this._reloadButton = this._iconButton('view-refresh-symbolic', this._('Reload services'), () => this._loadConfig());
        this._saveButton = this._iconButton('document-save-symbolic', this._('Save services'), () => this._saveConfig());

        box.append(this._addButton);
        box.append(this._restoreButton);
        box.append(this._reloadButton);
        box.append(this._saveButton);
        row.add_suffix(box);
        return row;
    }

    _iconButton(iconName, tooltipText, callback) {
        const button = new Gtk.Button({
            icon_name: iconName,
            tooltip_text: tooltipText,
            valign: Gtk.Align.CENTER,
        });
        button.add_css_class('flat');
        button.connect('clicked', callback);
        return button;
    }

    _loadDefaultEntries() {
        try {
            const basePath = this.path || this.dir?.get_path();
            const file = Gio.File.new_for_path(`${basePath}/tools/units.default.json`);
            const [, contents] = file.load_contents(null);
            const text = new TextDecoder('utf-8').decode(contents);
            const entries = JSON.parse(text);
            return Array.isArray(entries) ? entries : [];
        } catch (error) {
            logError(error, 'Service Pauser: failed to load default service catalog');
            return [];
        }
    }

    _setBusy(busy) {
        [this._addButton, this._restoreButton, this._reloadButton, this._saveButton].forEach(button => {
            if (button) {
                button.sensitive = !busy;
            }
        });
    }

    _setMessage(title, subtitle = '') {
        this._messageRow.title = title;
        this._messageRow.subtitle = subtitle;
    }

    _loadConfig() {
        this._setBusy(true);
        this._setMessage(this._('Loading services'), CONFIG_PATH);

        Promise.all([
            this._helper.run('config-get'),
            this._helper.run('catalog-status', JSON.stringify(this._defaultEntries)),
        ])
            .then(([configPayload, catalogPayload]) => {
                this._entries = Array.isArray(configPayload.entries) ? configPayload.entries : [];
                const catalogEntries = Array.isArray(catalogPayload.entries) ? catalogPayload.entries : [];
                this._defaultStatusById = new Map(catalogEntries.map(entry => [entry.id, entry]));
                this._rebuildServiceRows();
                this._setMessage(this._('Services loaded'), CONFIG_PATH);
            })
            .catch(error => {
                this._setMessage(this._('Setup required'), error.message || this._('Unknown error'));
            })
            .finally(() => {
                this._setBusy(false);
            });
    }

    _saveConfig() {
        const { entries, errors } = this._collectEntries();
        if (errors.length > 0) {
            this._setMessage(this._('Fix service entries'), errors.join('\n'));
            return;
        }

        this._setBusy(true);
        this._setMessage(this._('Saving services'), CONFIG_PATH);

        this._helper.run('config-set', JSON.stringify(entries))
            .then(payload => {
                this._entries = Array.isArray(payload.entries) ? payload.entries : entries;
                this._rebuildServiceRows();
                this._setMessage(this._('Service configuration saved'), CONFIG_PATH);
            })
            .catch(error => {
                this._setMessage(this._('Save failed'), error.message || this._('Unknown error'));
            })
            .finally(() => {
                this._setBusy(false);
            });
    }

    _addEntry() {
        this._entries = this._rawEntriesFromRows();
        this._entries.push({
            id: '',
            label: '',
            service: '',
            timer: null,
            optional: false,
            enabled: true,
        });
        this._rebuildServiceRows();
        this._setMessage(this._('Service added'), this._('Fill in the new row, then save.'));
    }

    _removeEntry(index) {
        this._entries = this._rawEntriesFromRows().filter((entry, entryIndex) => entryIndex !== index);
        this._rebuildServiceRows();
        this._setMessage(this._('Service removed'), this._('Save services to apply this change.'));
    }

    _restoreCatalog() {
        const entries = this._rawEntriesFromRows();
        const seen = new Set(entries.map(entry => entry.service).filter(Boolean));
        let changed = 0;

        this._setBusy(true);
        this._setMessage(this._('Loading built-in catalog'), CONFIG_PATH);

        this._helper.run('catalog-status', JSON.stringify(this._defaultEntries))
            .then(payload => {
                const catalogEntries = Array.isArray(payload.entries) ? payload.entries : [];
                this._defaultStatusById = new Map(catalogEntries.map(entry => [entry.id, entry]));

                this._defaultEntries.forEach(defaultEntry => {
                    const enabled = Boolean(this._defaultStatusById.get(defaultEntry.id)?.recommended_enabled);
                    const existingEntry = entries.find(entry => entry.service === defaultEntry.service);

                    if (existingEntry) {
                        if (existingEntry.enabled !== enabled) {
                            changed += 1;
                        }
                        existingEntry.enabled = enabled;
                        existingEntry.optional = true;
                        return;
                    }

                    entries.push({ ...defaultEntry, optional: true, enabled });
                    changed += 1;
                    seen.add(defaultEntry.service);
                });

                this._entries = entries;
                this._rebuildServiceRows();
                this._setMessage(
                    this._('Built-in catalog restored'),
                    changed > 0 ? this._('Save services to apply this change.') : this._('All built-in services are already listed.')
                );
            })
            .catch(error => {
                this._setMessage(this._('Setup required'), error.message || this._('Unknown error'));
            })
            .finally(() => {
                this._setBusy(false);
            });
    }

    _rebuildServiceRows() {
        this._serviceRows.forEach(controls => {
            this._servicesListGroup.remove(controls.row);
        });
        this._serviceRows = [];

        if (this._entries.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: this._('No services configured'),
                subtitle: this._('Add a service or restore the built-in catalog.'),
            });
            this._servicesListGroup.add(emptyRow);
            this._serviceRows.push({ row: emptyRow });
            return;
        }

        this._entries.forEach((entry, index) => {
            const row = new Adw.ExpanderRow({
                title: entry.label || this._('Unnamed service'),
                subtitle: unitSubtitle(entry, this._),
            });
            const labelRow = new Adw.EntryRow({
                title: this._('Label'),
                text: entry.label || '',
            });
            const serviceRow = new Adw.EntryRow({
                title: this._('Service unit'),
                text: entry.service || '',
            });
            const timerRow = new Adw.EntryRow({
                title: this._('Timer unit (optional)'),
                text: entry.timer || '',
            });
            const enabledRow = new Adw.ActionRow({
                title: this._('Use with pause button'),
                subtitle: this._entryAvailabilitySubtitle(entry),
            });
            const enabledSwitch = new Gtk.Switch({
                active: entry.enabled !== false,
                valign: Gtk.Align.CENTER,
            });
            const removeRow = new Adw.ActionRow({ title: this._('Remove service') });
            const removeButton = this._iconButton('user-trash-symbolic', this._('Remove service'), () => this._removeEntry(index));

            enabledRow.add_suffix(enabledSwitch);
            enabledRow.activatable_widget = enabledSwitch;
            removeRow.add_suffix(removeButton);
            removeRow.activatable_widget = removeButton;
            row.add_row(labelRow);
            row.add_row(serviceRow);
            row.add_row(timerRow);
            row.add_row(enabledRow);
            row.add_row(removeRow);

            const controls = { row, labelRow, serviceRow, timerRow, enabledSwitch, entry };
            const syncTitle = () => {
                row.title = labelRow.text.trim() || this._('Unnamed service');
                row.subtitle = unitSubtitle({
                    service: serviceRow.text.trim(),
                    timer: timerRow.text.trim(),
                }, this._);
            };

            labelRow.connect('changed', syncTitle);
            serviceRow.connect('changed', syncTitle);
            timerRow.connect('changed', syncTitle);

            this._servicesListGroup.add(row);
            this._serviceRows.push(controls);
        });
    }

    _rawEntriesFromRows() {
        return this._serviceRows
            .filter(controls => controls.labelRow)
            .map(controls => ({
                id: controls.entry.id || '',
                label: controls.labelRow.text.trim(),
                service: controls.serviceRow.text.trim(),
                timer: controls.timerRow.text.trim() || null,
                optional: Boolean(controls.entry.optional),
                enabled: controls.enabledSwitch?.active ?? true,
            }));
    }

    _collectEntries() {
        const errors = [];
        const entries = [];
        const seenServices = new Set();
        const usedIds = new Set();

        this._serviceRows
            .filter(controls => controls.labelRow)
            .forEach((controls, index) => {
                const label = controls.labelRow.text.trim();
                const service = controls.serviceRow.text.trim();
                const timer = controls.timerRow.text.trim();
                const rowName = label || service || `${this._('Service')} ${index + 1}`;

                if (!label && !service && !timer) {
                    return;
                }
                if (!label) {
                    errors.push(`${this._('Label is required')}: ${rowName}`);
                }
                if (!service) {
                    errors.push(`${this._('Service unit is required')}: ${rowName}`);
                } else if (!VALID_SERVICE_RE.test(service)) {
                    errors.push(`${this._('Service unit must end in .service')}: ${service}`);
                } else if (seenServices.has(service)) {
                    errors.push(`${this._('Duplicate service unit')}: ${service}`);
                }
                if (timer && !VALID_TIMER_RE.test(timer)) {
                    errors.push(`${this._('Timer unit must end in .timer')}: ${timer}`);
                }

                if (!label || !service || !VALID_SERVICE_RE.test(service) || (timer && !VALID_TIMER_RE.test(timer))) {
                    return;
                }

                seenServices.add(service);
                const id = this._entryId(controls.entry, service, usedIds);
                const optional = this._isOptionalDefault(controls.entry, service, timer);
                const enabled = controls.enabledSwitch?.active ?? true;
                const entry = { id, label, service };

                if (timer) {
                    entry.timer = timer;
                }
                if (optional) {
                    entry.optional = true;
                }
                if (!enabled) {
                    entry.enabled = false;
                }

                entries.push(entry);
            });

        return { entries, errors };
    }

    _entryId(sourceEntry, service, usedIds) {
        let base = sourceEntry.id && VALID_ID_RE.test(sourceEntry.id) ? sourceEntry.id : '';
        if (!base) {
            base = service
                .replace(/\.service$/, '')
                .replace(/[^A-Za-z0-9_.@:-]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'service';
        }

        let id = base;
        let counter = 2;
        while (usedIds.has(id)) {
            id = `${base}-${counter}`;
            counter += 1;
        }

        usedIds.add(id);
        return id;
    }

    _isOptionalDefault(sourceEntry, service, timer) {
        const defaultEntry = this._defaultsById.get(sourceEntry.id);
        if (defaultEntry) {
            return defaultEntry.service === service && (defaultEntry.timer || '') === (timer || '');
        }

        return Boolean(sourceEntry.optional) &&
            sourceEntry.service === service &&
            (sourceEntry.timer || '') === (timer || '');
    }

    _entryAvailabilitySubtitle(entry) {
        const status = this._defaultStatusById.get(entry.id);
        if (!status) {
            return this._('Custom service');
        }
        if (!status.available) {
            return this._('Not available on this system');
        }
        if (status.recommended_enabled) {
            return this._('Available and active');
        }
        return this._('Available but currently inactive');
    }

    _switchRow(settings, label, key) {
        const row = new Adw.ActionRow({ title: label });
        const sw = new Gtk.Switch({
            active: settings.get_boolean(key),
            valign: Gtk.Align.CENTER,
        });
        settings.bind(key, sw, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(sw);
        row.activatable_widget = sw;
        return row;
    }

    _spinRow(settings, label, key, min, max, step) {
        const row = new Adw.ActionRow({ title: label });
        const adj = new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: step,
            page_increment: step * 5,
            value: settings.get_int(key),
        });
        const spin = new Gtk.SpinButton({
            adjustment: adj,
            digits: 0,
            valign: Gtk.Align.CENTER,
        });
        settings.bind(key, adj, 'value', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(spin);
        row.activatable_widget = spin;
        return row;
    }

    _infoRow(title, subtitle) {
        return new Adw.ActionRow({ title, subtitle });
    }

    _targetsControlRow() {
        const row = new Adw.ActionRow({
            title: this._('Switch configuration'),
            subtitle: this._('Applied directly via GSettings, no privileged helper needed.'),
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        this._addTargetButton = this._iconButton('list-add-symbolic', this._('Add switch'), () => this._addTarget());
        this._restoreFoldersizeButton = this._iconButton('document-revert-symbolic', this._('Restore Folder Size default'), () => this._restoreFoldersizeDefault());
        this._reloadTargetsButton = this._iconButton('view-refresh-symbolic', this._('Reload switches'), () => this._loadTargets());
        this._saveTargetsButton = this._iconButton('document-save-symbolic', this._('Save switches'), () => this._saveTargets());

        box.append(this._addTargetButton);
        box.append(this._restoreFoldersizeButton);
        box.append(this._reloadTargetsButton);
        box.append(this._saveTargetsButton);
        row.add_suffix(box);
        return row;
    }

    _setTargetsMessage(title, subtitle = '') {
        this._targetsMessageRow.title = title;
        this._targetsMessageRow.subtitle = subtitle;
    }

    _loadTargets() {
        try {
            const raw = this._settings.get_string('gsettings-targets');
            const parsed = JSON.parse(raw);
            this._targets = Array.isArray(parsed) ? parsed : [];
            this._setTargetsMessage(this._('Switches loaded'), 'gsettings-targets');
        } catch (error) {
            logError(error, 'Service Pauser: failed to parse gsettings-targets');
            this._targets = [];
            this._setTargetsMessage(this._('Failed to load switches'), error.message || this._('Unknown error'));
        }

        this._rebuildTargetRows();
    }

    _saveTargets() {
        const { entries, errors } = this._collectTargets();
        if (errors.length > 0) {
            this._setTargetsMessage(this._('Fix GSettings switches'), errors.join('\n'));
            return;
        }

        this._settings.set_string('gsettings-targets', JSON.stringify(entries));
        this._targets = entries;
        this._rebuildTargetRows();
        this._setTargetsMessage(this._('GSettings switches saved'), 'gsettings-targets');
    }

    _addTarget() {
        this._targets = this._rawTargetsFromRows();
        this._targets.push({
            id: '',
            label: '',
            schema: '',
            key: '',
            pause_value: false,
            enabled: true,
        });
        this._rebuildTargetRows();
        this._setTargetsMessage(this._('Switch added'), this._('Fill in the new row, then save.'));
    }

    _removeTarget(index) {
        this._targets = this._rawTargetsFromRows().filter((entry, entryIndex) => entryIndex !== index);
        this._rebuildTargetRows();
        this._setTargetsMessage(this._('Switch removed'), this._('Save switches to apply this change.'));
    }

    _restoreFoldersizeDefault() {
        const entries = this._rawTargetsFromRows();
        const existingIndex = entries.findIndex(entry =>
            entry.schema === FOLDERSIZE_TARGET_PRESET.schema && entry.key === FOLDERSIZE_TARGET_PRESET.key);

        if (existingIndex >= 0) {
            entries[existingIndex] = {
                ...entries[existingIndex],
                ...FOLDERSIZE_TARGET_PRESET,
                id: entries[existingIndex].id || FOLDERSIZE_TARGET_PRESET.id,
            };
            this._setTargetsMessage(this._('Folder Size default updated'), this._('Save switches to apply this change.'));
        } else {
            entries.push({ ...FOLDERSIZE_TARGET_PRESET });
            this._setTargetsMessage(this._('Folder Size default added'), this._('Save switches to apply this change.'));
        }

        this._targets = entries;
        this._rebuildTargetRows();
    }

    _resolveSchema(schemaId, extensionUuid) {
        if (!schemaId) {
            return null;
        }

        try {
            return lookupTargetSchema(this._schemaSource, schemaId, extensionUuid);
        } catch (error) {
            return null;
        }
    }

    _targetAvailabilitySubtitle(entry) {
        const schema = this._resolveSchema(entry.schema, entry.extension_uuid);
        if (!schema) {
            return this._('Schema not installed');
        }

        if (!entry.key || !schema.has_key(entry.key) || schema.get_key(entry.key).get_value_type().dup_string() !== 'b') {
            return this._('Key not found or not boolean');
        }

        return this._('Available');
    }

    _rebuildTargetRows() {
        this._targetRows.forEach(controls => {
            this._targetsListGroup.remove(controls.row);
        });
        this._targetRows = [];

        if (this._targets.length === 0) {
            const emptyRow = new Adw.ActionRow({
                title: this._('No GSettings switches configured'),
                subtitle: this._('Add a switch or restore the Folder Size default.'),
            });
            this._targetsListGroup.add(emptyRow);
            this._targetRows.push({ row: emptyRow });
            return;
        }

        this._targets.forEach((entry, index) => {
            const row = new Adw.ExpanderRow({
                title: entry.label || this._('Unnamed switch'),
                subtitle: targetSubtitle(entry, this._),
            });

            const labelRow = new Adw.EntryRow({ title: this._('Label'), text: entry.label || '' });
            const schemaRow = new Adw.EntryRow({ title: this._('Schema id'), text: entry.schema || '' });
            const keyRow = new Adw.EntryRow({ title: this._('Key'), text: entry.key || '' });
            const ownToggleRow = new Adw.EntryRow({
                title: this._('Hide own toggle key (optional)'),
                text: entry.own_toggle_key || '',
            });
            const extensionUuidRow = new Adw.EntryRow({
                title: this._('Extension UUID (optional, for non-system-wide schemas)'),
                text: entry.extension_uuid || '',
            });

            const pauseRow = new Adw.ActionRow({ title: this._('Turn off when pausing') });
            const pauseSwitch = new Gtk.Switch({ active: Boolean(entry.pause_value), valign: Gtk.Align.CENTER });
            pauseRow.add_suffix(pauseSwitch);
            pauseRow.activatable_widget = pauseSwitch;

            const enabledRow = new Adw.ActionRow({
                title: this._('Use with pause button'),
                subtitle: this._targetAvailabilitySubtitle(entry),
            });
            const enabledSwitch = new Gtk.Switch({ active: entry.enabled !== false, valign: Gtk.Align.CENTER });
            enabledRow.add_suffix(enabledSwitch);
            enabledRow.activatable_widget = enabledSwitch;

            if (!this._resolveSchema(entry.schema, entry.extension_uuid) && entry.install_url) {
                const linkButton = new Gtk.LinkButton({
                    label: this._('Get extension'),
                    uri: entry.install_url,
                    valign: Gtk.Align.CENTER,
                });
                enabledRow.add_suffix(linkButton);
            }

            const removeRow = new Adw.ActionRow({ title: this._('Remove switch') });
            const removeButton = this._iconButton('user-trash-symbolic', this._('Remove switch'), () => this._removeTarget(index));
            removeRow.add_suffix(removeButton);
            removeRow.activatable_widget = removeButton;

            row.add_row(labelRow);
            row.add_row(schemaRow);
            row.add_row(keyRow);
            row.add_row(extensionUuidRow);
            row.add_row(ownToggleRow);
            row.add_row(pauseRow);
            row.add_row(enabledRow);
            row.add_row(removeRow);

            const controls = { row, labelRow, schemaRow, keyRow, ownToggleRow, extensionUuidRow, pauseSwitch, enabledSwitch, entry };
            const syncTitle = () => {
                row.title = labelRow.text.trim() || this._('Unnamed switch');
                row.subtitle = targetSubtitle({
                    schema: schemaRow.text.trim(),
                    key: keyRow.text.trim(),
                }, this._);
            };

            labelRow.connect('changed', syncTitle);
            schemaRow.connect('changed', syncTitle);
            keyRow.connect('changed', syncTitle);

            this._targetsListGroup.add(row);
            this._targetRows.push(controls);
        });
    }

    _rawTargetsFromRows() {
        return this._targetRows
            .filter(controls => controls.labelRow)
            .map(controls => {
                const entry = {
                    id: controls.entry.id || '',
                    label: controls.labelRow.text.trim(),
                    schema: controls.schemaRow.text.trim(),
                    key: controls.keyRow.text.trim(),
                    pause_value: controls.pauseSwitch?.active ?? false,
                    enabled: controls.enabledSwitch?.active ?? true,
                };

                const ownToggleKey = controls.ownToggleRow.text.trim();
                if (ownToggleKey) {
                    entry.own_toggle_key = ownToggleKey;
                }
                const extensionUuid = controls.extensionUuidRow.text.trim();
                if (extensionUuid) {
                    entry.extension_uuid = extensionUuid;
                }
                if (controls.entry.install_url) {
                    entry.install_url = controls.entry.install_url;
                }

                return entry;
            });
    }

    _collectTargets() {
        const errors = [];
        const entries = [];
        const usedIds = new Set();

        this._targetRows
            .filter(controls => controls.labelRow)
            .forEach((controls, index) => {
                const label = controls.labelRow.text.trim();
                const schemaId = controls.schemaRow.text.trim();
                const key = controls.keyRow.text.trim();
                const ownToggleKey = controls.ownToggleRow.text.trim();
                const extensionUuid = controls.extensionUuidRow.text.trim();
                const rowName = label || schemaId || `${this._('Switch')} ${index + 1}`;

                if (!label && !schemaId && !key) {
                    return;
                }
                if (!label) {
                    errors.push(`${this._('Label is required')}: ${rowName}`);
                }
                if (!schemaId) {
                    errors.push(`${this._('Schema id is required')}: ${rowName}`);
                }
                if (!key) {
                    errors.push(`${this._('Key is required')}: ${rowName}`);
                }

                if (!label || !schemaId || !key) {
                    return;
                }

                const id = this._targetId(controls.entry, schemaId, key, usedIds);
                const entry = {
                    id,
                    label,
                    schema: schemaId,
                    key,
                    pause_value: controls.pauseSwitch.active,
                    enabled: controls.enabledSwitch.active,
                };

                if (ownToggleKey) {
                    entry.own_toggle_key = ownToggleKey;
                }
                if (extensionUuid) {
                    entry.extension_uuid = extensionUuid;
                }
                if (controls.entry.install_url) {
                    entry.install_url = controls.entry.install_url;
                }

                entries.push(entry);
            });

        return { entries, errors };
    }

    _targetId(sourceEntry, schemaId, key, usedIds) {
        let base = sourceEntry.id && VALID_ID_RE.test(sourceEntry.id) ? sourceEntry.id : '';
        if (!base) {
            base = `${schemaId}-${key}`
                .replace(/[^A-Za-z0-9_.@:-]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'switch';
        }

        let id = base;
        let counter = 2;
        while (usedIds.has(id)) {
            id = `${base}-${counter}`;
            counter += 1;
        }

        usedIds.add(id);
        return id;
    }
}
