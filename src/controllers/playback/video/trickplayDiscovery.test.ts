import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { describe, expect, it } from 'vitest';

import { selectTrickplayResolution, TrickplayDiscovery } from './trickplayDiscovery';

const mediaSourceId = 'media-source';

function itemWithWidths(...widths: number[]): BaseItemDto {
    return {
        Trickplay: {
            [mediaSourceId]: Object.fromEntries(
                widths.map(width => [width, { Width: width }])
            )
        }
    };
}

describe('selectTrickplayResolution', () => {
    it('selects the highest resolution within the display target', () => {
        const resolution = selectTrickplayResolution(
            itemWithWidths(160, 320, 640),
            mediaSourceId,
            400
        );

        expect(resolution?.Width).toBe(320);
    });

    it('selects the smallest resolution when every option exceeds the target', () => {
        const resolution = selectTrickplayResolution(
            itemWithWidths(640, 320),
            mediaSourceId,
            200
        );

        expect(resolution?.Width).toBe(320);
    });
});

describe('TrickplayDiscovery', () => {
    it('retries transient misses and reports trickplay when it becomes available', async () => {
        let loadCount = 0;
        const loadItem = async () => {
            loadCount++;
            if (loadCount === 1) {
                throw new Error('temporary failure');
            }

            return loadCount === 2 ? {} : itemWithWidths(320);
        };
        const discovery = new TrickplayDiscovery(1);
        const resolution = await new Promise<number | undefined>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Discovery timed out')), 1_000);
            discovery.start(loadItem, mediaSourceId, 400, (_item, availableResolution) => {
                clearTimeout(timeout);
                resolve(availableResolution.Width);
            });
        });

        expect(loadCount).toBe(3);
        expect(resolution).toBe(320);
    });

    it('ignores an in-flight response after discovery is stopped', async () => {
        const deferred: { resolve?: (item: BaseItemDto) => void } = {};
        const loadItem = () => new Promise<BaseItemDto>(resolve => {
            deferred.resolve = resolve;
        });
        let available = false;
        const discovery = new TrickplayDiscovery(1);

        discovery.start(loadItem, mediaSourceId, 400, () => {
            available = true;
        });
        await new Promise(resolve => setTimeout(resolve, 10));
        discovery.stop();
        deferred.resolve?.(itemWithWidths(320));
        await Promise.resolve();

        expect(available).toBe(false);
    });
});
