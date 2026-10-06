// NOTE: This should be included in the OpenAPI spec ideally
// https://github.com/jellyfin/jellyfin/blob/1b4394199a2f9883cd601bdb8c9d66015397aa52/Jellyfin.Data/Enums/HomeSectionType.cs
// SlopTank deviation (c188): `watchlist` is a SlopTank-added section type.
export enum HomeSectionType {
    None = 'none',
    SmallLibraryTiles = 'smalllibrarytiles',
    LibraryButtons = 'librarybuttons',
    ActiveRecordings = 'activerecordings',
    Resume = 'resume',
    ResumeAudio = 'resumeaudio',
    LatestMedia = 'latestmedia',
    NextUp = 'nextup',
    LiveTv = 'livetv',
    ResumeBook = 'resumebook',
    Watchlist = 'watchlist'
}

// NOTE: This needs to match the server defaults
// https://github.com/jellyfin/jellyfin/blob/1b4394199a2f9883cd601bdb8c9d66015397aa52/Jellyfin.Api/Controllers/DisplayPreferencesController.cs#L120
// SlopTank deviation (c188): My List is a first-class home destination, so
// the watchlist section takes the second default slot and the trailing
// empty slot is dropped.
export const DEFAULT_SECTIONS: HomeSectionType[] = [
    HomeSectionType.SmallLibraryTiles,
    HomeSectionType.Watchlist,
    HomeSectionType.Resume,
    HomeSectionType.ResumeAudio,
    HomeSectionType.ResumeBook,
    HomeSectionType.LiveTv,
    HomeSectionType.NextUp,
    HomeSectionType.LatestMedia
];
