(() => {
  const AUTO_UPDATE_KEY = 'kantrack_auto_update';
  const autoUpdate = localStorage.getItem(AUTO_UPDATE_KEY) !== 'false';
  const params = new URLSearchParams(window.location.search);

  const autoUpdateInput = document.getElementById('auto-update');
  const launchLoginInput = document.getElementById('launch-login');
  const checkButton = document.getElementById('check-updates');
  const installButton = document.getElementById('install-update');
  const updateStatus = document.getElementById('update-status');
  const appVersion = document.getElementById('app-version');
  const tauri = window.__TAURI__;
  let availableUpdate = null;

  autoUpdateInput.checked = autoUpdate;
  autoUpdateInput.addEventListener('change', () => {
    localStorage.setItem(AUTO_UPDATE_KEY, String(autoUpdateInput.checked));
  });

  async function loadLaunchAtLogin() {
    if (!tauri?.core?.invoke) return;

    try {
      launchLoginInput.checked = await tauri.core.invoke('plugin:autostart|is_enabled');
    } catch (error) {}
  }

  launchLoginInput.addEventListener('change', async () => {
    if (!tauri?.core?.invoke) return;

    launchLoginInput.disabled = true;
    try {
      if (launchLoginInput.checked) {
        await tauri.core.invoke('plugin:autostart|enable');
      } else {
        await tauri.core.invoke('plugin:autostart|disable');
      }
    } catch (error) {
      launchLoginInput.checked = !launchLoginInput.checked;
    } finally {
      launchLoginInput.disabled = false;
    }
  });

  async function loadAppVersion() {
    if (!tauri?.core?.invoke) {
      appVersion.textContent = 'development';
      return;
    }

    try {
      appVersion.textContent = await tauri.core.invoke('plugin:app|version');
    } catch (error) {
      appVersion.textContent = 'unknown';
    }
  }

  function setStatus(message) {
    updateStatus.textContent = message;
  }

  function setBusy(isBusy) {
    checkButton.disabled = isBusy;
    installButton.disabled = isBusy;
  }

  function setInstallVisible(isVisible) {
    installButton.hidden = !isVisible;
  }

  function createProgressChannel() {
    const channel = new tauri.core.Channel();
    channel.onmessage = (event) => {
      if (event.event === 'Started') setStatus('Downloading update...');
      if (event.event === 'Progress') setStatus('Downloading update...');
      if (event.event === 'Finished') setStatus('Installing update...');
    };
    return channel;
  }

  async function installAvailableUpdate() {
    if (!availableUpdate) return;

    setBusy(true);
    setInstallVisible(false);
    setStatus(`Installing ${availableUpdate.version}...`);

    try {
      await tauri.core.invoke('plugin:updater|download_and_install', {
        rid: availableUpdate.rid,
        onEvent: createProgressChannel(),
      });
      setStatus('Update installed. Relaunching...');
      await tauri.core.invoke('plugin:process|restart');
    } catch (error) {
      const message = typeof error === 'string' ? error : error?.message;
      setStatus(message ? `Update install failed: ${message}` : 'Update install failed.');
      setInstallVisible(true);
    } finally {
      setBusy(false);
    }
  }

  async function checkForUpdates({ installAutomatically = false } = {}) {
    if (!tauri?.core?.invoke) {
      setStatus('Updates are available in the packaged app.');
      return;
    }

    availableUpdate = null;
    setInstallVisible(false);
    setBusy(true);
    setStatus('Checking for updates...');

    try {
      const metadata = await tauri.core.invoke('plugin:updater|check');
      if (!metadata) {
        setStatus('KanTrack is up to date.');
        return;
      }

      availableUpdate = metadata;
      setStatus(`Update ${metadata.version} is available.`);
      setInstallVisible(!installAutomatically);
      if (installAutomatically) await installAvailableUpdate();
    } catch (error) {
      const message = typeof error === 'string' ? error : error?.message;
      setStatus(message ? `Update check failed: ${message}` : 'Update check failed.');
    } finally {
      setBusy(false);
    }
  }

  checkButton.addEventListener('click', () => {
    checkForUpdates({ installAutomatically: false });
  });

  window.addEventListener('kantrack-check-updates', () => {
    checkForUpdates({ installAutomatically: false });
  });

  installButton.addEventListener('click', installAvailableUpdate);
  loadAppVersion();
  loadLaunchAtLogin();

  if (params.get('checkUpdates') === '1') {
    setTimeout(() => checkForUpdates({ installAutomatically: false }), 250);
  }
})();
