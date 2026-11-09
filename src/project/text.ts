/** Comparison key that ignores case, accents, spaces and punctuation. */
export function normalize(text: string): string {
    return text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

export function truncate(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function plural(count: number, word: string, many = `${word}s`): string {
    return `${count} ${1 === count ? word : many}`;
}

export function parseDuration(value: string | undefined): number | null {
    if (undefined === value || '' === value) {
        return null;
    }
    const match = /^(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value.trim());
    const seconds = match ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : NaN;
    if (!match || !(seconds > 0)) {
        throw new Error(`Unreadable duration "${value}": write for example 300, 300s, 5m or 4m30s.`);
    }

    return seconds;
}
