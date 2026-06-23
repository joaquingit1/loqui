/**
 * Audio input device enumeration for the capture picker (PRD-1).
 *
 * Thin wrapper over `navigator.mediaDevices.enumerateDevices()` that returns
 * only `audioinput` devices. Note: device LABELS are blank until the user has
 * granted mic permission at least once (a browser/Electron privacy rule), so
 * the picker shows a generic fallback label until then.
 */
export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

/** List available audio input devices (microphones). Never throws. */
export async function listAudioInputs(
  enumerate: () => Promise<MediaDeviceInfo[]> = () =>
    navigator.mediaDevices.enumerateDevices(),
): Promise<AudioInputDevice[]> {
  try {
    const devices = await enumerate();
    return devices
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      }));
  } catch {
    return [];
  }
}
