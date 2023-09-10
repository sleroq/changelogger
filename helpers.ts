export function getEnv(key: string, defaultValue?: string): string {
    const value = Deno.env.get(key);
    if (!value) {
        if (defaultValue) return defaultValue;
        throw new Error(`Environment variable ${key} is required`);
    }
    return value;
}

export interface Message {
    text: string | undefined;
    reply_to_message?: Message;
    forward: boolean;
    forwardUrl?: string;
    user: {
        id: number;
        username?: string;
    };
}

interface Chat {
    messages: { [key: string]: Message };
    prompt?: string;
}

interface Memory {
    [key: string]: Chat;
}

export async function loadMemory() {
    let data;

    try {
        data = await Deno.readTextFile('memory.json');
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            data = '{}';
        } else {
            throw new Error(`Error reading memory file: ${error.message}`);
        }
    }

    let parsedData: Memory;
    try {
        parsedData = JSON.parse(data);
    } catch (error) {
        throw new Error(`Invalid memory file: ${error.message}`);
    }

    return parsedData;
}

export async function saveMemory(memory: Memory) {
    const data = JSON.stringify(memory);
    await Deno.writeTextFile('memory.json', data);
}