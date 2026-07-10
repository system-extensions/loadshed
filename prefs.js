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

export default class ServicePauserPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._ = this.gettext.bind(this);
        this._helper = new HelperClient();
        this._entries = [];
        this._serviceRows = [];
        this._defaultEntries = this._loadDefaultEntries();
        this._defaultsById = new Map(this._defaultEntries.map(entry => [entry.id, entry]));

        const settings = this.getSettings(SCHEMA_ID);
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

        const pathsGroup = new Adw.PreferencesGroup({ title: this._('System files') });
        page.add(pathsGroup);
        pathsGroup.add(this._infoRow(this._('Helper'), HELPER_INSTALL_PATH));
        pathsGroup.add(this._infoRow(this._('Services'), CONFIG_PATH));

        window.set_default_size(680, 620);
        this._loadConfig();
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

        this._helper.run('config-get')
            .then(payload => {
                this._entries = Array.isArray(payload.entries) ? payload.entries : [];
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
        let added = 0;

        this._defaultEntries.forEach(defaultEntry => {
            if (!seen.has(defaultEntry.service)) {
                entries.push({ ...defaultEntry, optional: true });
                seen.add(defaultEntry.service);
                added += 1;
            }
        });

        this._entries = entries;
        this._rebuildServiceRows();
        this._setMessage(
            this._('Built-in catalog restored'),
            added > 0 ? this._('Save services to apply this change.') : this._('All built-in services are already listed.')
        );
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
            const removeRow = new Adw.ActionRow({ title: this._('Remove service') });
            const removeButton = this._iconButton('user-trash-symbolic', this._('Remove service'), () => this._removeEntry(index));

            removeRow.add_suffix(removeButton);
            removeRow.activatable_widget = removeButton;
            row.add_row(labelRow);
            row.add_row(serviceRow);
            row.add_row(timerRow);
            row.add_row(removeRow);

            const controls = { row, labelRow, serviceRow, timerRow, entry };
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
                const entry = { id, label, service };

                if (timer) {
                    entry.timer = timer;
                }
                if (optional) {
                    entry.optional = true;
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
}
