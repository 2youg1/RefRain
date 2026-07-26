/** Text that travels inside the prompt's XML-shaped protocol. */
export const xmlText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Attribute values need the text escapes plus both quote characters. */
export const xmlAttribute = (text: string): string =>
  xmlText(text).replaceAll('"', "&quot;").replaceAll("'", "&apos;");

/** CDATA carries manuscript text verbatim and splits its only closing sequence. */
export const cdata = (text: string): string =>
  `<![CDATA[${text.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
