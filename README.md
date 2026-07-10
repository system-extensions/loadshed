# Service Pauser

GNOME Shell extension for pausing selected background maintenance services from Quick Settings.

The extension delegates privileged work to `/usr/local/bin/service-pauser-helper`.
The helper reads and writes root-owned units in `/etc/service-pauser/units.json` and uses
`systemctl freeze`/`systemctl thaw` for services. Timers configured next to a service
are stopped while paused and only restarted if the helper stopped them. While the
Quick Settings button is paused, refreshes enforce that state again for configured
services that start later.

## Install

```bash
cd /home/yurij/web/git/service-pauser@yurij.de
glib-compile-schemas schemas
gnome-extensions pack . --force --podir=po --gettext-domain=service-pauser --extra-source=install.sh --extra-source=README.md --extra-source=tools -o /tmp
gnome-extensions install -f /tmp/service-pauser@yurij.de.shell-extension.zip
./install.sh
```

Log out and back in, then enable:

```bash
gnome-extensions enable service-pauser@yurij.de
```

## Configure Services

Open the extension preferences in GNOME Extensions to add, remove, save, reload,
or restore the built-in maintenance catalog. The default catalog is installed only
when `/etc/service-pauser/units.json` does not already exist; updates keep your
existing configuration.

Run `./install.sh` after updating the extension so the helper and sudoers rules
include the configuration and enforce commands.

Advanced users can still edit `/etc/service-pauser/units.json` as root. Built-in
catalog entries are marked optional, so services not installed on the machine are
ignored silently. Custom entries are not optional by default, so mistakes remain
visible in the menu. Entry format:

```json
[
  {
    "id": "aide",
    "label": "AIDE daily check",
    "service": "dailyaidecheck.service",
    "timer": "dailyaidecheck.timer",
    "optional": true
  }
]
```

## Manual Recovery

```bash
sudo /usr/local/bin/service-pauser-helper status
sudo /usr/local/bin/service-pauser-helper resume
sudo /usr/local/bin/service-pauser-helper config-get
```
