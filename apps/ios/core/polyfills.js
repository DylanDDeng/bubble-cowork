// Bare JavaScriptCore (JSContext) has no TextEncoder/TextDecoder; the desktop
// change-record parser uses them for UTF-8 escapes in diff paths.
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(input = "") {
      const out = [];
      for (const ch of String(input)) {
        let c = ch.codePointAt(0);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return Uint8Array.from(out);
    }
  };
}
if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = class TextDecoder {
    get encoding() { return "utf-8"; }
    decode(input) {
      const b = input instanceof Uint8Array ? input : new Uint8Array(input ?? []);
      let s = "";
      for (let i = 0; i < b.length; ) {
        const x = b[i++];
        let c;
        if (x < 0x80) c = x;
        else if (x >= 0xf0) c = ((x & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (x >= 0xe0) c = ((x & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (x >= 0xc0) c = ((x & 31) << 6) | (b[i++] & 63);
        else c = 0xfffd;
        s += String.fromCodePoint(Number.isFinite(c) && c <= 0x10ffff ? c : 0xfffd);
      }
      return s;
    }
  };
}
