import { useMemo, useState } from 'react';
import { File } from 'lucide-react';

const VSCODE_ICONS_BASE_URL =
  'https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@v12.17.0/icons';

const FILE_ICON_BY_EXTENSION: Record<string, string> = {
  ts: 'file_type_typescript.svg',
  tsx: 'file_type_reactts.svg',
  js: 'file_type_js.svg',
  jsx: 'file_type_reactjs.svg',
  json: 'file_type_json.svg',
  md: 'file_type_markdown.svg',
  html: 'file_type_html.svg',
  htm: 'file_type_html.svg',
  css: 'file_type_css.svg',
  scss: 'file_type_scss.svg',
  yml: 'file_type_yaml.svg',
  yaml: 'file_type_yaml.svg',
  xml: 'file_type_xml.svg',
  svg: 'file_type_svg.svg',
  png: 'file_type_image.svg',
  jpg: 'file_type_image.svg',
  jpeg: 'file_type_image.svg',
  gif: 'file_type_image.svg',
  webp: 'file_type_image.svg',
  bmp: 'file_type_image.svg',
  ico: 'file_type_image.svg',
  ppt: 'file_type_powerpoint.svg',
  pptx: 'file_type_powerpoint.svg',
  key: 'file_type_keynote.svg',
  zip: 'file_type_zip.svg',
  gz: 'file_type_zip.svg',
  tar: 'file_type_zip.svg',
  rar: 'file_type_zip.svg',
  '7z': 'file_type_zip.svg',
};

export function getFileTypeIconUrl(name: string): string {
  const lower = name.toLowerCase();
  const parts = lower.split('.');
  const extension = parts.length > 1 ? parts[parts.length - 1] : '';
  const iconFilename = FILE_ICON_BY_EXTENSION[extension] || 'default_file.svg';
  return `${VSCODE_ICONS_BASE_URL}/${iconFilename}`;
}

export function FileTypeIcon({
  name,
  className = 'h-4 w-4',
  fallbackClassName = 'h-3.5 w-3.5 text-[var(--text-secondary)]',
}: {
  name: string;
  className?: string;
  fallbackClassName?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const iconUrl = useMemo(() => getFileTypeIconUrl(name), [name]);

  if (failedUrl === iconUrl) {
    return <File className={fallbackClassName} strokeWidth={1.9} />;
  }

  return (
    <img
      src={iconUrl}
      alt=""
      aria-hidden="true"
      className={className}
      loading="lazy"
      onError={() => setFailedUrl(iconUrl)}
    />
  );
}
