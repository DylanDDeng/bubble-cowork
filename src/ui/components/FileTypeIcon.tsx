import { useMemo, useState } from 'react';
import { File } from 'lucide-react';
import defaultFileIconUrl from '../assets/vscode-icons/default_file.svg';
import cssIconUrl from '../assets/vscode-icons/file_type_css.svg';
import htmlIconUrl from '../assets/vscode-icons/file_type_html.svg';
import imageIconUrl from '../assets/vscode-icons/file_type_image.svg';
import jsIconUrl from '../assets/vscode-icons/file_type_js.svg';
import jsonIconUrl from '../assets/vscode-icons/file_type_json.svg';
import markdownIconUrl from '../assets/vscode-icons/file_type_markdown.svg';
import powerpointIconUrl from '../assets/vscode-icons/file_type_powerpoint.svg';
import reactJsIconUrl from '../assets/vscode-icons/file_type_reactjs.svg';
import reactTsIconUrl from '../assets/vscode-icons/file_type_reactts.svg';
import scssIconUrl from '../assets/vscode-icons/file_type_scss.svg';
import svgIconUrl from '../assets/vscode-icons/file_type_svg.svg';
import typescriptIconUrl from '../assets/vscode-icons/file_type_typescript.svg';
import yamlIconUrl from '../assets/vscode-icons/file_type_yaml.svg';

const FILE_ICON_URL_BY_EXTENSION: Record<string, string> = {
  ts: typescriptIconUrl,
  tsx: reactTsIconUrl,
  js: jsIconUrl,
  jsx: reactJsIconUrl,
  json: jsonIconUrl,
  md: markdownIconUrl,
  html: htmlIconUrl,
  htm: htmlIconUrl,
  css: cssIconUrl,
  scss: scssIconUrl,
  yml: yamlIconUrl,
  yaml: yamlIconUrl,
  svg: svgIconUrl,
  png: imageIconUrl,
  jpg: imageIconUrl,
  jpeg: imageIconUrl,
  gif: imageIconUrl,
  webp: imageIconUrl,
  bmp: imageIconUrl,
  ico: imageIconUrl,
  ppt: powerpointIconUrl,
  pptx: powerpointIconUrl,
};

export function getFileTypeIconUrl(name: string): string {
  const lower = name.toLowerCase();
  const parts = lower.split('.');
  const extension = parts.length > 1 ? parts[parts.length - 1] : '';
  return FILE_ICON_URL_BY_EXTENSION[extension] || defaultFileIconUrl;
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
