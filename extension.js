import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import { Extension, gettext as _, ngettext } from 'resource:///org/gnome/shell/extensions/extension.js';

const HELPER_INSTALL_PATH = '/usr/local/bin/service-pauser-helper';
const DEFAULT_REFRESH_INTERVAL = 10;
const TARGETS_SETTINGS_KEY = 'gsettings-targets';
// Schemas compiled only inside another extension's own directory (the
// common case — most extensions don't install schemas system-wide) aren't
// found by Gio.SettingsSchemaSource.get_default(). Mirror the two locations
// GNOME Shell itself installs/loads extensions from as a fallback.
const EXTENSION_SEARCH_DIRS = [
    GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'gnome-shell', 'extensions']),
    '/usr/share/gnome-shell/extensions',
];

function formatCountLabel(label, count) {
    return label.replace('%d', String(count));
}

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

/**
 * Bridges the pause button to arbitrary GSettings booleans (e.g. the
 * foldersize `auto-scan` switch) for background work that isn't a systemd
 * unit. Schema/key lookups are resolved defensively: constructing
 * Gio.Settings for an unknown schema id aborts the whole process, so every
 * schema is looked up via Gio.SettingsSchemaSource first and the entry is
 * skipped silently (not paused, no crash) if it isn't installed.
 */
class GSettingsTargets {
    constructor(settings) {
        this._settings = settings;
        this._resolved = [];
        this._load();
    }

    reload() {
        this._load();
    }

    _load() {
        this._resolved = [];

        let entries = [];
        try {
            const raw = this._settings.get_string(TARGETS_SETTINGS_KEY);
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                entries = parsed;
            }
        } catch (error) {
            logError(error, 'Service Pauser: failed to parse gsettings-targets');
        }

        const schemaSource = Gio.SettingsSchemaSource.get_default();

        entries.forEach(entry => {
            if (!entry || typeof entry !== 'object' || !entry.schema || !entry.key) {
                return;
            }

            const gsettings = this._resolveBoolSetting(schemaSource, entry.schema, entry.key, entry.extension_uuid);
            if (!gsettings) {
                return;
            }

            let ownToggle = null;
            if (entry.own_toggle_key) {
                ownToggle = this._resolveBoolSetting(schemaSource, entry.schema, entry.own_toggle_key, entry.extension_uuid);
            }

            this._resolved.push({ entry, gsettings, ownToggle });
        });
    }

    _resolveBoolSetting(schemaSource, schemaId, key, extensionUuid) {
        try {
            const schema = lookupTargetSchema(schemaSource, schemaId, extensionUuid);
            if (!schema || !schema.has_key(key)) {
                return null;
            }

            if (schema.get_key(key).get_value_type().dup_string() !== 'b') {
                return null;
            }

            return new Gio.Settings({ settingsSchema: schema });
        } catch (error) {
            logError(error, `Service Pauser: failed to resolve ${schemaId}::${key}`);
            return null;
        }
    }

    _activeResolved() {
        return this._resolved.filter(item => item.entry.enabled !== false);
    }

    applyPause() {
        this._setPaused(true);
    }

    applyResume() {
        this._setPaused(false);
    }

    enforce() {
        // Called periodically while the pause button stays checked, so a
        // target flipped back on by something else gets re-paused.
        this._setPaused(true);
    }

    _setPaused(paused) {
        this._activeResolved().forEach(item => {
            const pauseValue = Boolean(item.entry.pause_value);
            const value = paused ? pauseValue : !pauseValue;
            item.gsettings.set_boolean(item.entry.key, value);
        });
    }

    hideOwnToggles() {
        this._activeResolved().forEach(item => {
            if (item.ownToggle) {
                item.ownToggle.set_boolean(item.entry.own_toggle_key, false);
            }
        });
    }

    restoreOwnToggles() {
        this._resolved.forEach(item => {
            if (item.ownToggle) {
                item.ownToggle.set_boolean(item.entry.own_toggle_key, true);
            }
        });
    }

    status() {
        return this._activeResolved().map(item => {
            let running = false;
            try {
                running = item.gsettings.get_boolean(item.entry.key) !== Boolean(item.entry.pause_value);
            } catch (error) {
                running = false;
            }

            return {
                id: item.entry.id,
                label: item.entry.label || item.entry.id,
                service_active: running,
                paused: !running,
                service_frozen: false,
            };
        });
    }
}

class ServicePauserManager {
    constructor(settings) {
        this._targets = new GSettingsTargets(settings);
    }

    reloadTargets() {
        this._targets.reload();
    }

    applyPause() {
        this._targets.applyPause();
    }

    applyResume() {
        this._targets.applyResume();
    }

    enforceTargets() {
        this._targets.enforce();
    }

    targetsStatus() {
        return this._targets.status();
    }

    hideOwnToggles() {
        this._targets.hideOwnToggles();
    }

    restoreOwnToggles() {
        this._targets.restoreOwnToggles();
    }

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

    run(action) {
        let argv;
        try {
            argv = this._helperCommand(action);
        } catch (error) {
            return Promise.reject(error);
        }

        return new Promise((resolve, reject) => {
            try {
                const proc = new Gio.Subprocess({
                    argv,
                    flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                });
                proc.init(null);
                proc.communicate_utf8_async(null, null, (source, res) => {
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

                        const message = payload?.error || stderr?.trim() || stdout?.trim() || _('Helper command failed');
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

    resumeDetached() {
        let argv;
        try {
            argv = this._helperCommand('resume');
        } catch {
            return;
        }

        try {
            GLib.spawn_async(
                null,
                argv,
                null,
                GLib.SpawnFlags.SEARCH_PATH,
                null
            );
        } catch (error) {
            logError(error, 'Service Pauser: failed to resume on disable');
        }
    }
}

const ServicePauserToggle = GObject.registerClass(
class ServicePauserToggle extends QuickSettings.QuickMenuToggle {
    _init(extensionObject, manager, indicator) {
        super._init({
            title: _('Stop Load'),
            subtitle: _('Loading'),
            iconName: 'media-playback-pause-symbolic',
            toggleMode: true,
        });

        this._settings = extensionObject._settings;
        this._manager = manager;
        this._indicator = indicator;
        this._busy = false;
        this._entryItems = [];
        this._refreshSourceId = 0;
        this._settingsSignalIds = [];

        this.menu.setHeader('media-playback-pause-symbolic', _('Stop Load'), _('Background services'));
        this._itemsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._itemsSection);
        this.menu.addAction(_('Refresh'), () => this._refresh());
        this.menu.addAction(_('Resume managed services'), () => this._runAction('resume'));
        this.menu.addAction(_('Setup help'), () => this._notifySetupRequired());

        this._clickedId = this.connect('clicked', () => this._togglePaused());

        this._settingsSignalIds.push(this._settings.connect('changed::refresh-interval', () => {
            this._restartRefreshTimer();
        }));

        this._settingsSignalIds.push(this._settings.connect('changed::show-quick-settings', () => {
            this.visible = this._settings.get_boolean('show-quick-settings');
        }));

        this.visible = this._settings.get_boolean('show-quick-settings');
        this._restartRefreshTimer();
        this._refresh();
    }

    destroy() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        if (this._clickedId) {
            this.disconnect(this._clickedId);
            this._clickedId = 0;
        }

        this._settingsSignalIds.forEach(id => this._settings.disconnect(id));
        this._settingsSignalIds = [];
        this._clearEntryItems();

        super.destroy();
    }

    _restartRefreshTimer() {
        if (this._refreshSourceId) {
            GLib.Source.remove(this._refreshSourceId);
            this._refreshSourceId = 0;
        }

        const interval = Math.max(
            2,
            this._settings.get_int('refresh-interval') || DEFAULT_REFRESH_INTERVAL
        );

        this._refreshSourceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _togglePaused() {
        if (this._busy) {
            return;
        }

        this._runAction(this.checked ? 'pause' : 'resume');
    }

    _refresh() {
        if (this._busy) {
            return;
        }

        const action = this.checked ? 'enforce' : 'status';
        if (this.checked) {
            this._manager.enforceTargets();
        }

        this._busy = true;
        this.subtitle = _('Refreshing');
        this._manager.run(action)
            .then(status => this._applyStatus(status))
            .catch(error => this._handleError(error))
            .finally(() => {
                this._busy = false;
            });
    }

    _runAction(action) {
        if (this._busy) {
            return;
        }

        if (action === 'pause') {
            this._manager.applyPause();
        } else if (action === 'resume') {
            this._manager.applyResume();
        }

        this._busy = true;
        this.subtitle = action === 'pause' ? _('Pausing') : _('Resuming');
        this._manager.run(action)
            .then(status => this._applyStatus(status))
            .catch(error => this._handleError(error))
            .finally(() => {
                this._busy = false;
            });
    }

    _handleError(error) {
        if (error?.payload) {
            this._applyStatus(error.payload);
        } else {
            // No usable helper response (e.g. helper not set up yet). Fall
            // through the normal status path with no helper entries — any
            // GSettings targets are still managed directly by us and keep
            // showing their real status instead of the menu going blank.
            this._applyStatus({});
        }

        const message = error?.message || _('Unknown error');
        if (message === 'setup required') {
            this.subtitle = _('Setup required');
            this._notifySetupRequired();
            return;
        }

        this.subtitle = _('Error');
        Main.notify(_('Service Pauser'), message);
    }

    _notifySetupRequired() {
        Main.notify(
            _('Service Pauser setup required'),
            _('Run install.sh from the extension directory, then reload GNOME Shell or re-enable the extension.')
        );
    }

    _applyStatus(status) {
        const helperEntries = Array.isArray(status.entries) ? status.entries : [];
        const targetEntries = this._manager.targetsStatus();
        const entries = helperEntries.concat(targetEntries);

        const pausedCount = Number(status.paused_count || 0) + targetEntries.filter(entry => entry.paused).length;
        const runningCount = Number(status.running_count || 0) + targetEntries.filter(entry => !entry.paused).length;
        // With real systemd services configured, trust the helper's own
        // "paused" flag. With none (targets only, or nothing at all),
        // derive it from the combined entries instead.
        const paused = helperEntries.length > 0
            ? Boolean(status.paused)
            : entries.length > 0 && entries.every(entry => entry.paused);

        this.checked = paused;
        this._indicator.visible = paused;

        if (entries.length === 0) {
            this.subtitle = _('No services configured');
        } else if (pausedCount > 0) {
            this.subtitle = formatCountLabel(ngettext('1 paused', '%d paused', pausedCount), pausedCount);
        } else if (runningCount > 0) {
            this.subtitle = formatCountLabel(ngettext('1 running', '%d running', runningCount), runningCount);
        } else {
            this.subtitle = _('Nothing running');
        }

        if (Array.isArray(status.errors) && status.errors.length > 0) {
            this.subtitle = _('Partial error');
            Main.notify(_('Service Pauser'), status.errors.join('\n'));
        }

        this._rebuildEntryItems(entries);
    }

    _clearEntryItems() {
        this._entryItems.forEach(item => item.destroy());
        this._entryItems = [];
    }

    _rebuildEntryItems(entries) {
        this._clearEntryItems();

        const visibleEntries = [];
        const hiddenEntries = [];

        entries.forEach(entry => {
            if (this._entryVisible(entry)) {
                visibleEntries.push(entry);
            } else {
                hiddenEntries.push(entry);
            }
        });

        visibleEntries.forEach(entry => {
            this._addEntryItem(entry.label || entry.id || _('Unknown'), this._entryIcon(entry));
        });

        if (hiddenEntries.length > 0) {
            this._addEntryItem(
                this._hiddenEntriesLabel(hiddenEntries),
                this._hiddenEntriesIcon(hiddenEntries),
                'service-pauser-summary-entry'
            );
        }
    }

    _addEntryItem(label, iconName, extraStyleClass = '') {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: `popup-menu-item service-pauser-entry ${extraStyleClass}`,
        });
        const box = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'popup-menu-item-content service-pauser-entry-content',
        });
        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon service-pauser-entry-icon',
        });
        const title = new St.Label({
            text: label,
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'service-pauser-entry-label',
        });

        box.add_child(icon);
        box.add_child(title);
        item.actor.add_child(box);
        this._itemsSection.addMenuItem(item);
        this._entryItems.push(item);
    }

    _entryVisible(entry) {
        return Boolean(entry.error) || (
            entry.service_active &&
            !entry.paused &&
            !entry.service_frozen
        );
    }

    _entryPaused(entry) {
        return Boolean(entry.paused || entry.service_frozen);
    }

    _hiddenEntriesLabel(entries) {
        const pausedCount = entries.filter(entry => this._entryPaused(entry)).length;
        const releasedCount = entries.length - pausedCount;

        if (releasedCount === 0) {
            return formatCountLabel(ngettext('1 service paused', '%d services paused', pausedCount), pausedCount);
        }

        if (pausedCount === 0) {
            return formatCountLabel(ngettext('1 service released', '%d services released', releasedCount), releasedCount);
        }

        const pausedLabel = formatCountLabel(ngettext('1 paused', '%d paused', pausedCount), pausedCount);
        const releasedLabel = formatCountLabel(ngettext('1 released', '%d released', releasedCount), releasedCount);
        return _('%s, %s').format(pausedLabel, releasedLabel);
    }

    _hiddenEntriesIcon(entries) {
        const pausedCount = entries.filter(entry => this._entryPaused(entry)).length;

        if (pausedCount === entries.length) {
            return 'media-playback-pause-symbolic';
        }
        if (pausedCount === 0) {
            return 'emblem-ok-symbolic';
        }
        return 'dialog-information-symbolic';
    }

    _entryIcon(entry) {
        if (entry.error) {
            return 'dialog-warning-symbolic';
        }
        if (entry.paused || entry.service_frozen) {
            return 'media-playback-pause-symbolic';
        }
        if (entry.service_active) {
            return 'media-playback-start-symbolic';
        }
        return 'emblem-ok-symbolic';
    }
});

const ServicePauserIndicator = GObject.registerClass(
class ServicePauserIndicator extends QuickSettings.SystemIndicator {
    _init(extensionObject, manager) {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'media-playback-pause-symbolic';
        this._indicator.visible = false;

        this._toggle = new ServicePauserToggle(extensionObject, manager, this._indicator);
        this.quickSettingsItems.push(this._toggle);

        Main.panel.statusArea.quickSettings.addExternalIndicator(this);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class ServicePauserExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._settings = null;
        this._manager = null;
        this._indicator = null;
        this._targetsSignalId = 0;
    }

    enable() {
        this._settings = this.getSettings();
        this._manager = new ServicePauserManager(this._settings);
        // service-pauser takes over pausing for enabled GSettings targets,
        // so their own Quick Settings toggle (e.g. foldersize's) would be
        // redundant while we manage it.
        this._manager.hideOwnToggles();

        this._targetsSignalId = this._settings.connect('changed::gsettings-targets', () => {
            this._manager.restoreOwnToggles();
            this._manager.reloadTargets();
            this._manager.hideOwnToggles();
        });

        this._indicator = new ServicePauserIndicator(this, this._manager);
    }

    disable() {
        if (this._settings && this._targetsSignalId) {
            this._settings.disconnect(this._targetsSignalId);
        }
        this._targetsSignalId = 0;

        if (this._settings?.get_boolean('auto-resume-on-disable')) {
            this._manager?.resumeDetached();
            this._manager?.applyResume();
        }

        // Give back any own toggles we hid so the user never ends up
        // without a way to control the target once we stop managing it.
        this._manager?.restoreOwnToggles();

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._manager = null;
        this._settings = null;
    }
}
