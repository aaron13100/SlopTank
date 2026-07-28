import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { TrickplayInfoDto } from '@jellyfin/sdk/lib/generated-client/models/trickplay-info-dto';

export function selectTrickplayResolution(
    item: Pick<BaseItemDto, 'Trickplay'>,
    mediaSourceId: string,
    maxWidth: number
): TrickplayInfoDto | null {
    const resolutions = item.Trickplay?.[mediaSourceId];
    if (!resolutions) {
        return null;
    }

    let bestWidth: number | undefined;
    let bestResolution: TrickplayInfoDto | null = null;
    for (const [ widthKey, resolution ] of Object.entries(resolutions)) {
        const width = resolution.Width ?? Number(widthKey);
        if (!Number.isFinite(width)) {
            continue;
        }

        if (bestWidth === undefined
            || (width < bestWidth && bestWidth > maxWidth)
            || (width > bestWidth && width <= maxWidth)) {
            bestWidth = width;
            bestResolution = resolution;
        }
    }

    return bestResolution;
}

type LoadItem = () => Promise<BaseItemDto | null | undefined>;
type OnAvailable = (item: BaseItemDto, resolution: TrickplayInfoDto) => void;

/**
 * Polls an active item until the server publishes trickplay metadata.
 */
export class TrickplayDiscovery {
    private timeout?: ReturnType<typeof setTimeout>;
    private requestId = 0;

    public constructor(private readonly intervalMs = 10_000) {}

    public start(
        loadItem: LoadItem,
        mediaSourceId: string,
        maxWidth: number,
        onAvailable: OnAvailable
    ): void {
        this.stop();
        const requestId = this.requestId;

        const poll = async () => {
            try {
                const item = await loadItem();
                if (requestId !== this.requestId || !item) {
                    return;
                }

                const resolution = selectTrickplayResolution(item, mediaSourceId, maxWidth);
                if (resolution) {
                    this.stop();
                    onAvailable(item, resolution);
                    return;
                }
            } catch (error) {
                console.debug('Unable to refresh trickplay metadata; retrying.', error);
            }

            if (requestId === this.requestId) {
                this.timeout = setTimeout(poll, this.intervalMs);
            }
        };

        this.timeout = setTimeout(poll, this.intervalMs);
    }

    public stop(): void {
        this.requestId++;
        if (this.timeout !== undefined) {
            clearTimeout(this.timeout);
            this.timeout = undefined;
        }
    }
}
