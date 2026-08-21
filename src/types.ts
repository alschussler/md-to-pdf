export interface CliOptions {
  input: string;
  output: string;
  pageWidth: number;
  pageHeight: number;
  margins: [top: number, right: number, bottom: number, left: number];
  fontSize: number;
  lineHeight: number;
  pageNumbers: boolean;
  compress: boolean;
  title?: string;
  author?: string;
  subject?: string;
}
