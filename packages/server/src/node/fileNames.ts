/**
 * The device names Windows reserves in every folder: CON, PRN, AUX, NUL, COM0–COM9 and LPT0–LPT9,
 * in any case. Windows 10 and Server reserve them whatever the extension (`nul.demo` is the null
 * device there, `com1.cmap` a serial port), and a path check knows nothing of devices. The server
 * refuses them as demo and map names on every platform, so its names stay portable (D-051).
 */
const RESERVED_FILE_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Whether `base` (a file name without its extension) is a Windows device name. */
export function isReservedFileName(base: string): boolean {
  return RESERVED_FILE_NAME.test(base);
}

/** The reason a reserved name is refused, after the name. */
export const RESERVED_FILE_REASON = "is a reserved file name (a device on Windows)";
