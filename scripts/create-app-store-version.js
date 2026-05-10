import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'app-store', 'KanTrack');
const appStoreBundleId = 'com.chriscrdns.kantrack';
const appStoreTeamId = '9686TQV2VP';
const privacyUrl = 'https://github.com/ChrisCrdns/kantrack-releases/blob/main/PRIVACY.md';
const supportUrl = 'https://github.com/ChrisCrdns/kantrack-releases/blob/main/SUPPORT.md';

const skipNames = new Set([
  '.git',
  'app-store',
  'node_modules',
  'release',
  'target',
]);

const skipFiles = new Set([
  '.DS_Store',
]);

function copyProject() {
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  fs.mkdirSync(outDir, { recursive: true });

  for (const entry of fs.readdirSync(root)) {
    if (skipNames.has(entry) || skipFiles.has(entry)) continue;
    const source = path.join(root, entry);
    const destination = path.join(outDir, entry);
    fs.cpSync(source, destination, {
      recursive: true,
      filter(candidate) {
        const name = path.basename(candidate);
        if (skipNames.has(name) || skipFiles.has(name)) return false;
        if (candidate.includes(`${path.sep}src-tauri${path.sep}target${path.sep}`)) return false;
        return true;
      },
    });
  }
}

function read(relPath) {
  return fs.readFileSync(path.join(outDir, relPath), 'utf8');
}

function write(relPath, content) {
  fs.writeFileSync(path.join(outDir, relPath), content);
}

function updateJson(relPath, updater) {
  const filePath = path.join(outDir, relPath);
  const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  updater(json);
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function stripBetween(content, start, end) {
  const startIndex = content.indexOf(start);
  if (startIndex === -1) return content;
  const endIndex = content.indexOf(end, startIndex);
  if (endIndex === -1) return content;
  return content.slice(0, startIndex) + content.slice(endIndex + end.length);
}

copyProject();
fs.rmSync(path.join(outDir, 'scripts'), { recursive: true, force: true });

updateJson('package.json', (pkg) => {
  pkg.name = 'kantrack-app-store';
  delete pkg.dependencies?.['@tauri-apps/plugin-process'];
  delete pkg.dependencies?.['@tauri-apps/plugin-updater'];
  pkg.scripts = {
    tauri: pkg.scripts.tauri,
  };
});

updateJson('package-lock.json', (lock) => {
  if (lock.packages?.['']) {
    lock.packages[''].name = 'kantrack-app-store';
    delete lock.packages[''].dependencies?.['@tauri-apps/plugin-process'];
    delete lock.packages[''].dependencies?.['@tauri-apps/plugin-updater'];
  }
  delete lock.packages?.['node_modules/@tauri-apps/plugin-process'];
  delete lock.packages?.['node_modules/@tauri-apps/plugin-updater'];
  delete lock.dependencies?.['@tauri-apps/plugin-process'];
  delete lock.dependencies?.['@tauri-apps/plugin-updater'];
});

updateJson('src-tauri/tauri.conf.json', (config) => {
  config.identifier = appStoreBundleId;
  config.bundle.category = 'Productivity';
  delete config.bundle?.createUpdaterArtifacts;
  delete config.plugins?.updater;
  if (config.plugins && Object.keys(config.plugins).length === 0) delete config.plugins;
  config.bundle.macOS = {
    ...(config.bundle.macOS || {}),
    entitlements: 'Entitlements.plist',
    minimumSystemVersion: '13.0',
  };
});

let cargoToml = read('src-tauri/Cargo.toml');
cargoToml = cargoToml.replace(/\ntauri-plugin-process = "2"/, '');
cargoToml = cargoToml.replace(/\n\[target\.'cfg\(not\(any\(target_os = "android", target_os = "ios"\)\)\)'\.dependencies\]\ntauri-plugin-updater = "2"\n?/m, '\n');
write('src-tauri/Cargo.toml', cargoToml);

updateJson('src-tauri/capabilities/default.json', (capability) => {
  capability.permissions = capability.permissions.filter(
    (permission) => !['process:default', 'updater:default'].includes(permission)
  );
});

let rust = read('src-tauri/src/lib.rs');
rust = rust.replace(/\n\s*\.plugin\(tauri_plugin_process::init\(\)\)/, '');
rust = rust.replace(/\n\s*\.plugin\(tauri_plugin_updater::Builder::new\(\)\.build\(\)\)/, '');
rust = rust.replace(/\n\s*let check_updates = MenuItem::with_id\(\n\s*app,\n\s*"check_updates",\n\s*"Check for Updates\.\.\.",\n\s*true,\n\s*None::<&str>,\n\s*\)\?;/, '');
rust = rust.replace(/\n\s*&check_updates,/, '');
rust = rust.replace(/\n\s*"check_updates" => \{\n\s*open_settings_window\(app, true\);\n\s*\}/, '');
rust = rust.replace(/fn open_settings_window\(app: &tauri::AppHandle, check_updates: bool\)/, 'fn open_settings_window(app: &tauri::AppHandle, _check_updates: bool)');
rust = rust.replace(/\n\s*if check_updates \{\n\s*let _ = window\.eval\("window\.dispatchEvent\(new CustomEvent\('kantrack-check-updates'\)\)"\);\n\s*\}/, '');
rust = rust.replace(/\n\s*let settings_url = if check_updates \{\n\s*WebviewUrl::App\("settings\.html\?checkUpdates=1"\.into\(\)\)\n\s*\} else \{\n\s*WebviewUrl::App\("settings\.html"\.into\(\)\)\n\s*\};/, '\n    let settings_url = WebviewUrl::App("settings.html".into());');
write('src-tauri/src/lib.rs', rust);

write('src-tauri/build.rs', `fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/login_item.m")
            .flag("-fobjc-arc")
            .compile("kantrack_login_item");
        println!("cargo:rustc-link-lib=framework=ServiceManagement");
    }

    tauri_build::build()
}
`);

write('src-tauri/src/login_item.m', `#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static char *kantrack_copy_error(NSError *error) {
  const char *message = "Could not update Launch at Login.";
  if (error != nil && error.localizedDescription != nil) {
    message = error.localizedDescription.UTF8String;
  }
  return strdup(message);
}

bool kantrack_login_item_is_enabled(void) {
  if (@available(macOS 13.0, *)) {
    return SMAppService.mainAppService.status == SMAppServiceStatusEnabled;
  }
  return false;
}

char *kantrack_login_item_set_enabled(bool enabled) {
  if (@available(macOS 13.0, *)) {
    NSError *error = nil;
    BOOL ok = enabled
      ? [SMAppService.mainAppService registerAndReturnError:&error]
      : [SMAppService.mainAppService unregisterAndReturnError:&error];
    return ok ? NULL : kantrack_copy_error(error);
  }

  return strdup("Launch at Login requires macOS 13 or later.");
}

void kantrack_login_item_free_error(char *message) {
  free(message);
}
`);

write('src-tauri/Entitlements.plist', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.developer.team-identifier</key>
  <string>${appStoreTeamId}</string>
  <key>com.apple.application-identifier</key>
  <string>${appStoreTeamId}.${appStoreBundleId}</string>
  <key>com.apple.security.app-sandbox</key>
  <true/>
  <key>com.apple.security.files.user-selected.read-write</key>
  <true/>
</dict>
</plist>
`);

write('src-tauri/Info.plist', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.productivity</string>
  <key>ITSAppUsesNonExemptEncryption</key>
  <false/>
</dict>
</plist>
`);

let indexHtml = read('src/index.html');
indexHtml = indexHtml.replace(/\n    <div class="update-modal" id="update-modal" hidden>[\s\S]*?\n    <\/div>(?=\n  <\/div>\n\n  <script)/, '');
write('src/index.html', indexHtml);

let settingsHtml = read('src/settings.html');
settingsHtml = settingsHtml.replace(/\n\s*<section class="settings-section muted">\n\s*<div class="section-copy">\n\s*<h2>Updates<\/h2>[\s\S]*?<\/section>/, '');
settingsHtml = settingsHtml.replace(
  /\n\s*<div class="link-actions">/,
  '\n        <p class="setting-note">Launch at Login is off by default and only changes when you enable it.</p>\n\n        <div class="link-actions">'
);
settingsHtml = settingsHtml.replace(/\n\s*<\/div>\n\s*<\/section>\n\s*<\/main>/, `
      </div>
    </section>
  </main>`);
write('src/settings.html', settingsHtml);

write('src/settings.js', `(() => {
  const launchLoginInput = document.getElementById('launch-login');
  const appVersion = document.getElementById('app-version');
  const privacyButton = document.getElementById('privacy-policy');
  const supportButton = document.getElementById('support-link');
  const tauri = window.__TAURI__;

  async function openUrl(url) {
    if (tauri?.core?.invoke) {
      try {
        await tauri.core.invoke('plugin:opener|open_url', { url });
        return;
      } catch (error) {}
    }

    window.open(url, '_blank', 'noopener,noreferrer');
  }

  privacyButton?.addEventListener('click', () => openUrl('${privacyUrl}'));
  supportButton?.addEventListener('click', () => openUrl('${supportUrl}'));

  async function loadLaunchAtLogin() {
    if (!tauri?.core?.invoke || !launchLoginInput) return;

    try {
      launchLoginInput.checked = await tauri.core.invoke('is_launch_at_login_enabled');
    } catch (error) {
      launchLoginInput.checked = false;
    }
  }

  launchLoginInput?.addEventListener('change', async () => {
    if (!tauri?.core?.invoke) return;

    launchLoginInput.disabled = true;
    try {
      await tauri.core.invoke('set_launch_at_login', { enabled: launchLoginInput.checked });
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

  loadAppVersion();
  loadLaunchAtLogin();
})();
`);

let script = read('src/script.js');
const readJsonStart = script.indexOf('  function readJson');
const updaterStart = script.indexOf('  function initUpdater()');
const constantsStart = script.indexOf('  // ============================================================\n  // CONSTANTS');
if (readJsonStart === -1 || updaterStart === -1 || constantsStart === -1) {
  throw new Error('Could not find updater boundaries in src/script.js');
}
const jsonHelpers = script.slice(readJsonStart, updaterStart);
const appBody = script.slice(constantsStart);
script = `(() => {
  'use strict';

  const AUTOSIZE_KEY = 'kantrack_autosize';
  const WINDOW_WIDTH_KEY = 'kantrack_window_width';
  const FILTERS_KEY = 'kantrack_filters_v1';
  const AUTO_MOVE_COMPLETED_KEY = 'kantrack_auto_move_completed_v1';
  const ONBOARDING_SEEN_KEY = 'kantrack_onboarding_seen_v1';

${jsonHelpers}${appBody}`;
script = script.replace(/\.onboarding-modal:not\(\[hidden\]\), \.update-modal:not\(\[hidden\]\)/g, '.onboarding-modal:not([hidden])');
script = script.replace(/\.onboarding-card, \.update-card/g, '.onboarding-card');
script = script.replace(/\n\s*addDivider\(pop\);\n\s*addTitle\(pop, 'Updates'\);[\s\S]*?\n\s*const quitItem = addItem\(pop, 'Quit KanTrack'/, "\n\n      const quitItem = addItem(pop, 'Quit KanTrack'");
script = script.replace(/\n\s*showAfterUpdateRestartIfNeeded\(\);/, '');
write('src/script.js', script);

let settingsCss = read('src/settings.css');
settingsCss = settingsCss.replace(/\n\.update-actions \{[\s\S]*?\n\}\n\nbutton \{/, '\nbutton {');
settingsCss = settingsCss.replace(/\n#update-status \{[\s\S]*?\n\}\n\n@media/, '\n@media');
settingsCss = settingsCss.replace('\nbutton {', '\n.setting-note {\n  margin: 0;\n  color: #738097;\n  font-size: 12px;\n  line-height: 1.4;\n}\n\nbutton {');
write('src/settings.css', settingsCss);

let styles = read('src/styles.css');
styles = styles.replace(/\n\.update-modal \{[\s\S]*?\n\}\n\n\.onboarding-modal \{/, '\n.onboarding-modal {');
styles = styles.replace(/\n\.update-modal\[hidden\],[\s\S]*?\n#update-now \{[\s\S]*?\n\}\n\n@media/, '\n@media');
write('src/styles.css', styles);

write('README.md', `# KanTrack App Store Variant

This generated source copy removes the Tauri updater, GitHub update endpoint, update UI, and updater signing requirements from the main KanTrack app.

It sets the Mac App Store bundle identifier to \`${appStoreBundleId}\`, enables App Sandbox entitlements, includes the encryption export Info.plist key, and implements Launch at Login with Apple's SMAppService API. Launch at Login is off by default and only changes after explicit user action.

Before submission, make sure the App Store Connect Privacy Policy URL and Support URL point at live public pages:

- Privacy Policy: ${privacyUrl}
- Support: ${supportUrl}
`);

console.log(`App Store source written to ${outDir}`);
