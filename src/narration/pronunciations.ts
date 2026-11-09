import type { Pronunciation } from '../config/schema.ts';

/**
 * Spellings dictated to the voice instead of the written text, for words the synthesis reads by the general
 * rule of the language although usage differs (product names, jargon). Subtitles and anchors keep the spelling.
 */
export interface Spoken {
    spoken: string;
    // For each character of the written text, its position in the dictated text.
    map: number[];
}

function keepCase(written: string, spoken: string): string {
    return written[0] === written[0].toUpperCase() ? spoken[0].toUpperCase() + spoken.slice(1) : spoken;
}

export function toSpoken(text: string, rules: Pronunciation[]): Spoken {
    const replacements = rules
        .flatMap(({ written, flags, spoken }) =>
            [...text.matchAll(new RegExp(written, flags.includes('g') ? flags : `${flags}g`))].map((match) => ({
                start: match.index,
                end: match.index + match[0].length,
                spoken: keepCase(match[0], spoken),
            }))
        )
        .sort((a, b) => a.start - b.start);
    let spoken = '';
    const map: number[] = [];
    let cursor = 0;
    for (const replacement of replacements) {
        if (replacement.start < cursor) {
            continue;
        }
        for (; cursor < replacement.start; cursor++) {
            map.push(spoken.length);
            spoken += text[cursor];
        }
        const from = spoken.length;
        const length = replacement.end - replacement.start;
        for (let index = 0; index < length; index++) {
            map.push(from + Math.floor((index * replacement.spoken.length) / length));
        }
        spoken += replacement.spoken;
        cursor = replacement.end;
    }
    for (; cursor < text.length; cursor++) {
        map.push(spoken.length);
        spoken += text[cursor];
    }

    return { spoken, map };
}
