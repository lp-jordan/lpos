declare module 'html-to-docx' {
  type HtmlToDocxOptions = {
    title?: string;
  };

  export default function htmlToDocx(
    html: string,
    headerHtml?: string,
    options?: HtmlToDocxOptions
  ): Promise<Buffer>;
}
