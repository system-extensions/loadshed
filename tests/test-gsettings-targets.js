import Gio from 'gi://Gio';
import { GSettingsTargets } from '../gsettingsTargets.js';

const managerSettings = new Gio.Settings({
    schema_id: 'org.gnome.shell.extensions.service-pauser',
});
const targetSettings = new Gio.Settings({
    schema_id: 'org.example.service-pauser-target',
});

const target = {
    id: 'test-target',
    label: 'Test target',
    schema: 'org.example.service-pauser-target',
    key: 'active',
    pause_value: false,
    enabled: true,
    own_toggle_key: 'show-toggle',
};

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

function reset(active, showToggle) {
    managerSettings.set_string('gsettings-targets', JSON.stringify([target]));
    managerSettings.set_string('gsettings-runtime-state', '{"paused":{},"hidden":{}}');
    targetSettings.set_boolean('active', active);
    targetSettings.set_boolean('show-toggle', showToggle);
}

reset(false, false);
let manager = new GSettingsTargets(managerSettings);
manager.hideOwnToggles();
manager.applyPause();
manager.applyResume();
manager.restoreOwnToggles();
assertEqual(targetSettings.get_boolean('active'), false, 'resume preserves an originally disabled target');
assertEqual(targetSettings.get_boolean('show-toggle'), false, 'restore preserves an originally hidden toggle');

reset(true, true);
manager = new GSettingsTargets(managerSettings);
manager.hideOwnToggles();
manager.applyPause();
assertEqual(targetSettings.get_boolean('active'), false, 'pause applies the configured value');
assertEqual(targetSettings.get_boolean('show-toggle'), false, 'managed own toggle is hidden');

manager = new GSettingsTargets(managerSettings);
assertEqual(manager.status()[0].managed, true, 'pause state survives manager recreation');
targetSettings.set_boolean('active', true);
manager.enforce();
assertEqual(targetSettings.get_boolean('active'), false, 'enforce reapplies the pause value');
manager.applyResume();
manager.restoreOwnToggles();
assertEqual(targetSettings.get_boolean('active'), true, 'resume restores the original target value');
assertEqual(targetSettings.get_boolean('show-toggle'), true, 'restore returns the original own toggle value');

reset(true, true);
manager = new GSettingsTargets(managerSettings);
manager.hideOwnToggles();
manager.applyPause();
managerSettings.set_string('gsettings-targets', JSON.stringify([{ ...target, enabled: false }]));
manager.reload(true);
assertEqual(targetSettings.get_boolean('active'), true, 'disabling a target releases its saved value');
assertEqual(targetSettings.get_boolean('show-toggle'), true, 'disabling a target restores its own toggle');

print('GSettings target tests passed');
