// Bundled only into the Android build (www/native.js). Exposes native BLE + file sharing to app.js.
import { Capacitor } from '@capacitor/core';
import { BleClient } from '@capacitor-community/bluetooth-le';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
window.N54Native = { Capacitor, BleClient, Filesystem, Directory, Encoding, Share };
