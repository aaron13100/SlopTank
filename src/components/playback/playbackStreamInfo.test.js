import { describe, expect, it } from 'vitest';
import { createPlaybackStreamInfo } from './playbackStreamInfo';

const requestedStartTicks = 65_000_000;
const externalSubtitleUrl = '/Videos/item/source/Subtitles/2/0/Stream.vtt?ApiKey=test';

function createContext() {
    return {
        appHost: {
            supports: () => false
        },
        isLocalItem: () => false
    };
}

function createApiClient() {
    return {
        deviceId: () => 'browser-device',
        accessToken: () => 'test-token',
        getUrl: (url) => url
    };
}

describe('playbackStreamInfo external subtitle timeline', () => {
    it('keeps resumed timestamp-preserving HLS and external subtitle cues on source time', () => {
        const streamInfo = createPlaybackStreamInfo(createContext()).createStreamInfo(
            createApiClient(),
            'Video',
            {
                Id: 'item',
                Name: 'Synthetic resume fixture',
                MediaType: 'Video',
                ServerId: 'server'
            },
            {
                Id: 'source',
                Container: 'mp4',
                TranscodingContainer: 'ts',
                TranscodingSubProtocol: 'hls',
                TranscodingUrl: '/Videos/item/master.m3u8?CopyTimestamps=true&StartTimeTicks=' + requestedStartTicks,
                SupportsTranscoding: true,
                MediaStreams: [
                    {
                        Type: 'Subtitle',
                        Index: 2,
                        DeliveryMethod: 'External',
                        IsExternalUrl: false,
                        DeliveryUrl: externalSubtitleUrl
                    }
                ]
            },
            requestedStartTicks,
            { useFullSubtitleUrls: false }
        );

        expect(streamInfo.transcodingOffsetTicks).toBe(0);
        expect(streamInfo.playerStartPositionTicks).toBe(requestedStartTicks);
        expect(streamInfo.textTracks).toEqual([
            expect.objectContaining({
                index: 2,
                url: externalSubtitleUrl
            })
        ]);
    });
});
