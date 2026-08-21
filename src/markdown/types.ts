export type Align = 'left' | 'center' | 'right';

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'del'; children: Inline[] }
  | { type: 'link'; href: string; title: string | null; children: Inline[] }
  | { type: 'image'; src: string; alt: string; title: string | null }
  | { type: 'break' };

export interface ListItem {
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'codeBlock'; lang: string; value: string }
  | { type: 'blockquote'; children: Block[] }
  | { type: 'list'; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { type: 'thematicBreak' }
  | { type: 'table'; align: (Align | null)[]; header: Inline[][]; rows: Inline[][][] };

export interface LinkDefinition {
  href: string;
  title: string | null;
}

export type LinkDefinitions = Map<string, LinkDefinition>;

export interface Document {
  blocks: Block[];
  definitions: LinkDefinitions;
}

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}
