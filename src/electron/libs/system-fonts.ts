import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SystemFontFace, SystemFontFamily } from '../../shared/system-fonts';
const exec = promisify(execFile);
let cached: Promise<SystemFontFamily[]> | undefined;

/** Read installed font metadata only; never installs fonts or changes system preferences. */
export function getSystemFontFamilies(): Promise<SystemFontFamily[]> {
  return cached ??= readFonts().catch(error => { cached = undefined; throw error; });
}
export async function getSystemFonts(): Promise<string[]> {
  return (await getSystemFontFamilies()).map(font => font.family);
}
export function groupFontFaces(faces: SystemFontFace[]): SystemFontFamily[] {
  const families = new Map<string, SystemFontFace[]>();
  for (const face of faces) {
    if (!face.family || !face.postscriptName) continue;
    const list = families.get(face.family) ?? [];
    if (!list.some(item => item.postscriptName === face.postscriptName)) list.push(face);
    families.set(face.family, list);
  }
  const regular = (face: SystemFontFace) => /^(regular|normal|roman|book)$/i.test(face.style) ? 0 : 1;
  return [...families].map(([family, faces]) => ({ family, faces: faces.sort((a, b) => regular(a) - regular(b) || a.style.localeCompare(b.style)) }))
    .sort((a, b) => a.family.localeCompare(b.family));
}
async function readFonts(): Promise<SystemFontFamily[]> {
  const options = { timeout: 20000, maxBuffer: 24 * 1024 * 1024, windowsHide: true };
  let faces: SystemFontFace[];
  if (process.platform === 'darwin') {
    const { stdout } = await exec('/usr/sbin/system_profiler', ['SPFontsDataType', '-json'], options);
    const report = JSON.parse(stdout) as { SPFontsDataType?: { enabled?: string; typefaces?: { family?: string; enabled?: string; _name?: string; fullname?: string; style?: string }[] }[] };
    faces = (report.SPFontsDataType ?? []).filter(font => font.enabled !== 'no')
      .flatMap(font => (font.typefaces ?? []).filter(face => face.enabled !== 'no').map(face => ({
        family: face.family ?? '', fullName: face.fullname ?? face._name ?? '', postscriptName: face._name ?? '', style: face.style ?? 'Regular',
      })));
  } else if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; @((New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $fontFamily = $_; @("Regular", "Bold", "Italic", "Bold, Italic") | ForEach-Object { $fontStyle = [System.Drawing.FontStyle]$_; if ($fontFamily.IsStyleAvailable($fontStyle)) { $styleName = $_.Replace(",", ""); $fullName = if ($styleName -eq "Regular") { $fontFamily.Name } else { $fontFamily.Name + " " + $styleName }; @{ family=$fontFamily.Name; fullName=$fullName; postscriptName=$fullName; style=$styleName } } } }) | ConvertTo-Json -Compress'], options);
    const parsed = JSON.parse(stdout);
    faces = Array.isArray(parsed) ? parsed : [parsed];
  } else {
    const { stdout } = await exec('fc-list', ['--format', '%{family[0]}\t%{style[0]}\t%{fullname[0]}\t%{postscriptname}\n'], options);
    faces = stdout.split('\n').filter(Boolean).map(line => {
      const [family, style, fullName, postscriptName] = line.split('\t');
      return { family, style: style || 'Regular', fullName: fullName || family, postscriptName: postscriptName || fullName || family };
    });
  }
  return groupFontFaces(faces);
}
