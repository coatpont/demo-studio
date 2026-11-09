// Abbreviations after which a period does not end the sentence.
const TITLE = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|cf|p|pp|No|M|MM|Mme|Mmes|Mlle|Sra|Hr|Fr)\.$/;

/** What glues the next piece to the previous one ("Mr. Smith", "1.5", "etc. and"), or null if it starts a sentence. */
function joiner(previous: string, next: string): string | null {
    if (/\d\.$/.test(previous) && /^\d/.test(next)) {
        return '';
    }
    if (TITLE.test(previous) || (/\betc\.$/.test(previous) && /^\s*\p{Ll}/u.test(next))) {
        return ' ';
    }

    return null;
}

/** Splits a narration into sentences: each is synthesised alone, so that it can be shifted against the picture. */
export function splitSentences(text: string): string[] {
    const pieces =
        text
            .replace(/\s+/g, ' ')
            .trim()
            .match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [];
    const sentences: string[] = [];
    for (const raw of pieces) {
        const piece = raw.trim();
        const previous = sentences.at(-1);
        const glue = undefined === previous ? null : joiner(previous, raw);
        if (undefined !== previous && null !== glue) {
            sentences[sentences.length - 1] = `${previous}${glue}${piece}`;
        } else if (piece) {
            sentences.push(piece);
        }
    }

    return sentences;
}

/** Comparison form that keeps the text's length, so that a position found in it stays valid. */
function comparable(text: string): string {
    return [...text].map((char) => (/[’‘]/.test(char) ? "'" : /\s/.test(char) ? ' ' : char.toLowerCase())).join('');
}

export interface AnchorPosition {
    sentence: number;
    offset: number;
}

/** Locates a gesture's anchor in the sentences, searching from `from` since gestures follow the narration. */
export function findAnchor(sentences: string[], anchor: string, from = 0): AnchorPosition | null {
    const needle = comparable(anchor.replace(/\s+/g, ' ').trim());
    const order = [...sentences.keys()].filter((index) => index >= from).concat([...Array(from).keys()]);
    for (const index of order) {
        const offset = comparable(sentences[index]).indexOf(needle);
        if (offset >= 0) {
            return { sentence: index, offset };
        }
    }

    return null;
}
