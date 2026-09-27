declare module 'virtual:content-manifest' {
  export interface ManifestEntry {
    id: string;
    file: string;
    section: string;
    group: string;
    groupTitle: string;
    groupOrder: number;
    slug: string;
    order: number;
    title: string;
    description: string;
    difficulty: string;
    tags: string[];
    words: number;
    minutes: number;
    headings: { depth: number; text: string; id: string }[];
    questionCount: number;
    origin: string;
  }
  export const manifest: ManifestEntry[];
  export default manifest;
}

declare module 'virtual:content-search' {
  export const searchIndex: Record<string, string>;
  export default searchIndex;
}
