export interface SystemFontFace {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}
export interface SystemFontFamily {
  family: string;
  faces: SystemFontFace[];
}
