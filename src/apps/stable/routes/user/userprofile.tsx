import type { UserDto } from '@jellyfin/sdk/lib/generated-client';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import React, { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import animeSeaBreeze from 'assets/img/profile-avatars/anime-sea-breeze.png';
import animeSpacePilot from 'assets/img/profile-avatars/anime-space-pilot.png';
import animeSunset from 'assets/img/profile-avatars/anime-sunset.png';
import cartoonExplorer from 'assets/img/profile-avatars/cartoon-explorer.png';
import ceramicRedPanda from 'assets/img/profile-avatars/ceramic-red-panda.png';
import daisyFrog from 'assets/img/profile-avatars/daisy-frog.png';
import desertBloom from 'assets/img/profile-avatars/desert-bloom.png';
import feltAxolotl from 'assets/img/profile-avatars/felt-axolotl.png';
import geometricCreative from 'assets/img/profile-avatars/geometric-creative.png';
import mangaElder from 'assets/img/profile-avatars/manga-elder.png';
import moonlitFox from 'assets/img/profile-avatars/moonlit-fox.png';
import moonlitMountain from 'assets/img/profile-avatars/moonlit-mountain.png';
import mushroomGrove from 'assets/img/profile-avatars/mushroom-grove.png';
import neonCassette from 'assets/img/profile-avatars/neon-cassette.png';
import neonJellyfish from 'assets/img/profile-avatars/neon-jellyfish.png';
import oceanWhale from 'assets/img/profile-avatars/ocean-whale.png';
import paperDragon from 'assets/img/profile-avatars/paper-dragon.png';
import paperPortrait from 'assets/img/profile-avatars/paper-portrait.png';
import rainyCapybara from 'assets/img/profile-avatars/rainy-capybara.png';
import radiantSun from 'assets/img/profile-avatars/radiant-sun.png';
import retroRobot from 'assets/img/profile-avatars/retro-robot.png';
import risoLaugh from 'assets/img/profile-avatars/riso-laugh.png';
import spaceExplorer from 'assets/img/profile-avatars/space-explorer.png';
import stormCloud from 'assets/img/profile-avatars/storm-cloud.png';
import Dashboard from '../../../../utils/dashboard';
import globalize from '../../../../lib/globalize';
import { appHost } from '../../../../components/apphost';
import confirm from '../../../../components/confirm/confirm';
import toast from '../../../../components/toast/toast';
import { useUser } from 'apps/dashboard/features/users/api/useUser';
import loading from 'components/loading/loading';
import { queryClient } from 'utils/query/queryClient';
import UserPasswordForm from 'components/dashboard/users/UserPasswordForm';
import Page from 'components/Page';
import Loading from 'components/loading/LoadingComponent';
import Button from 'elements/emby-button/Button';
import { useApi } from 'hooks/useApi';

import './userprofile.scss';

interface ProfileAvatar {
    filename: string
    image: string
    nameKey: string
}

const profileAvatars: ProfileAvatar[] = [
    { filename: 'felt-axolotl.png', image: feltAxolotl, nameKey: 'AvatarFeltAxolotl' },
    { filename: 'rainy-capybara.png', image: rainyCapybara, nameKey: 'AvatarRainyCapybara' },
    { filename: 'daisy-frog.png', image: daisyFrog, nameKey: 'AvatarDaisyFrog' },
    { filename: 'ceramic-red-panda.png', image: ceramicRedPanda, nameKey: 'AvatarCeramicRedPanda' },
    { filename: 'cartoon-explorer.png', image: cartoonExplorer, nameKey: 'AvatarCartoonExplorer' },
    { filename: 'geometric-creative.png', image: geometricCreative, nameKey: 'AvatarGeometricCreative' },
    { filename: 'riso-laugh.png', image: risoLaugh, nameKey: 'AvatarRisoLaugh' },
    { filename: 'paper-portrait.png', image: paperPortrait, nameKey: 'AvatarPaperPortrait' },
    { filename: 'anime-space-pilot.png', image: animeSpacePilot, nameKey: 'AvatarAnimeSpacePilot' },
    { filename: 'anime-sea-breeze.png', image: animeSeaBreeze, nameKey: 'AvatarAnimeSeaBreeze' },
    { filename: 'anime-sunset.png', image: animeSunset, nameKey: 'AvatarAnimeSunset' },
    { filename: 'manga-elder.png', image: mangaElder, nameKey: 'AvatarMangaElder' },
    { filename: 'moonlit-fox.png', image: moonlitFox, nameKey: 'AvatarMoonlitFox' },
    { filename: 'retro-robot.png', image: retroRobot, nameKey: 'AvatarRetroRobot' },
    { filename: 'neon-jellyfish.png', image: neonJellyfish, nameKey: 'AvatarNeonJellyfish' },
    { filename: 'space-explorer.png', image: spaceExplorer, nameKey: 'AvatarSpaceExplorer' },
    { filename: 'mushroom-grove.png', image: mushroomGrove, nameKey: 'AvatarMushroomGrove' },
    { filename: 'radiant-sun.png', image: radiantSun, nameKey: 'AvatarRadiantSun' },
    { filename: 'paper-dragon.png', image: paperDragon, nameKey: 'AvatarPaperDragon' },
    { filename: 'desert-bloom.png', image: desertBloom, nameKey: 'AvatarDesertBloom' },
    { filename: 'ocean-whale.png', image: oceanWhale, nameKey: 'AvatarOceanWhale' },
    { filename: 'neon-cassette.png', image: neonCassette, nameKey: 'AvatarNeonCassette' },
    { filename: 'storm-cloud.png', image: stormCloud, nameKey: 'AvatarStormCloud' },
    { filename: 'moonlit-mountain.png', image: moonlitMountain, nameKey: 'AvatarMoonlitMountain' }
];

const UserProfile: FunctionComponent = () => {
    const [ searchParams ] = useSearchParams();
    const userId = searchParams.get('userId');
    const { data: user, isPending: isUserPending } = useUser(userId ? { userId } : undefined);
    const { refreshUser } = useApi();
    const libraryMenu = useMemo(async () => ((await import('../../../../scripts/libraryMenu')).default), []);
    const uploadImageInput = useRef<HTMLInputElement>(null);
    const avatarGrid = useRef<HTMLDivElement>(null);
    const [ canEditImage, setCanEditImage ] = useState(false);
    const [ isUploadingImage, setIsUploadingImage ] = useState(false);
    const [ previewImageUrl, setPreviewImageUrl ] = useState<string | null>(null);

    useEffect(() => {
        if (user?.Name) {
            void libraryMenu.then(menu => menu.setTitle(user.Name));
        }
    }, [ user?.Name, libraryMenu ]);

    useEffect(() => {
        let isDisposed = false;

        if (!user?.Policy) {
            setCanEditImage(false);
            return;
        }

        Dashboard.getCurrentUser().then((loggedInUser: UserDto) => {
            const canEdit = appHost.supports('fileinput')
                && Boolean(loggedInUser?.Policy?.IsAdministrator || user.Policy?.EnableUserPreferenceAccess);

            if (!isDisposed) {
                setCanEditImage(canEdit);
            }
        }).catch(err => {
            console.error('[userprofile] failed to get current user', err);
        });

        return () => {
            isDisposed = true;
        };
    }, [ user ]);

    const uploadUserImage = useCallback(async (file: File, previewUrl: string) => {
        if (!userId) {
            console.error('[userprofile] missing user id');
            return;
        }

        setIsUploadingImage(true);
        setPreviewImageUrl(previewUrl);
        loading.show();

        try {
            await window.ApiClient.uploadUserImage(userId, ImageType.Primary, file);
            await queryClient.invalidateQueries({
                queryKey: [ 'User' ]
            });
            if (userId === window.ApiClient.getCurrentUserId()) {
                await refreshUser?.();
            }
        } catch (err) {
            console.error('[userprofile] failed to upload image', err);
            setPreviewImageUrl(null);
            toast(globalize.translate('ImageUploadFailed'));
        } finally {
            loading.hide();
            setIsUploadingImage(false);
        }
    }, [ refreshUser, userId ]);

    const onFileReaderError = useCallback((evt: ProgressEvent<FileReader>) => {
        loading.hide();
        switch (evt.target?.error?.name) {
            case 'NotFoundError':
                toast(globalize.translate('FileNotFound'));
                break;
            case 'AbortError':
                toast(globalize.translate('FileReadCancelled'));
                break;
            default:
                toast(globalize.translate('FileReadError'));
        }
    }, []);

    const onUploadImage = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
        const file = evt.target.files?.[0];
        evt.target.value = '';

        if (!file || !/image.*/.exec(file.type)) {
            return;
        }

        const reader = new FileReader();
        reader.onerror = onFileReaderError;
        reader.onabort = () => toast(globalize.translate('FileReadCancelled'));
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                void uploadUserImage(file, reader.result);
            }
        };
        reader.readAsDataURL(file);
    }, [ onFileReaderError, uploadUserImage ]);

    const onPresetImageClick = useCallback((evt: React.MouseEvent<HTMLButtonElement>) => {
        if (isUploadingImage) {
            return;
        }

        const avatarIndex = Number(evt.currentTarget.dataset.avatarIndex);
        const avatar = profileAvatars[avatarIndex];
        const uploadPresetImage = async () => {
            try {
                const response = await fetch(avatar.image);
                if (!response.ok) {
                    throw new Error(`Avatar image request failed with status ${response.status}`);
                }

                const blob = await response.blob();
                const file = new File([ blob ], avatar.filename, {
                    type: blob.type || 'image/png'
                });
                await uploadUserImage(file, avatar.image);
            } catch (err) {
                console.error('[userprofile] failed to load preset image', err);
                toast(globalize.translate('ImageUploadFailed'));
            }
        };

        uploadPresetImage().catch(err => {
            console.error('[userprofile] unexpected preset image error', err);
        });
    }, [ isUploadingImage, uploadUserImage ]);

    const onAddImageClick = useCallback(() => {
        uploadImageInput.current?.click();
    }, []);

    const onPreviousAvatarPage = useCallback(() => {
        if (avatarGrid.current) {
            avatarGrid.current.scrollLeft -= avatarGrid.current.clientWidth * 0.8;
        }
    }, []);

    const onNextAvatarPage = useCallback(() => {
        if (avatarGrid.current) {
            avatarGrid.current.scrollLeft += avatarGrid.current.clientWidth * 0.8;
        }
    }, []);

    const onDeleteImageClick = useCallback(async () => {
        if (!userId) {
            console.error('[userprofile] missing user id');
            return;
        }

        try {
            await confirm(
                globalize.translate('DeleteImageConfirmation'),
                globalize.translate('DeleteImage')
            );
        } catch {
            return;
        }

        loading.show();
        try {
            await window.ApiClient.deleteUserImage(userId, ImageType.Primary);
            setPreviewImageUrl(null);
            await queryClient.invalidateQueries({
                queryKey: [ 'User' ]
            });
            if (userId === window.ApiClient.getCurrentUserId()) {
                await refreshUser?.();
            }
        } catch (err) {
            console.error('[userprofile] failed to delete image', err);
        } finally {
            loading.hide();
        }
    }, [ refreshUser, userId ]);

    if (isUserPending || !user) {
        return <Loading />;
    }

    let imageUrl = previewImageUrl || 'assets/img/avatar.png';
    if (!previewImageUrl && user.PrimaryImageTag && user.Id) {
        imageUrl = window.ApiClient.getUserImageUrl(user.Id, {
            tag: user.PrimaryImageTag,
            type: 'Primary'
        });
    }

    return (
        <Page
            id='userProfilePage'
            title={globalize.translate('Profile')}
            className='mainAnimatedPage libraryPage userPreferencesPage userPasswordPage noSecondaryNavPage'
        >
            <div className='padded-left padded-right padded-bottom-page'>
                <div className='userProfileHeader readOnlyContent'>
                    <div className='userProfileImagePlaceholder imagePlaceHolder'>
                        {canEditImage && (
                            <input
                                ref={uploadImageInput}
                                id='uploadImage'
                                className='userProfileImageInput'
                                type='file'
                                accept='image/*'
                                aria-label={globalize.translate('ButtonAddImage')}
                                disabled={isUploadingImage}
                                onChange={onUploadImage}
                            />
                        )}
                        <div
                            id='image'
                            className='userProfileImage'
                            style={{ backgroundImage: `url(${imageUrl})` }}
                        />
                    </div>
                    <div className='userProfileDetails'>
                        <h2 className='username userProfileName'>
                            {user.Name}
                        </h2>
                        {canEditImage && (
                            <>
                                <Button
                                    type='button'
                                    id='btnAddImage'
                                    className='raised button-submit'
                                    title={globalize.translate('ButtonAddImage')}
                                    disabled={isUploadingImage}
                                    onClick={onAddImageClick}
                                />
                                {user.PrimaryImageTag && (
                                    <Button
                                        type='button'
                                        id='btnDeleteImage'
                                        className='raised'
                                        title={globalize.translate('DeleteImage')}
                                        disabled={isUploadingImage}
                                        onClick={onDeleteImageClick}
                                    />
                                )}
                            </>
                        )}
                    </div>
                </div>
                {canEditImage && (
                    <section className='profileAvatarPicker readOnlyContent' aria-labelledby='profileAvatarPickerTitle'>
                        <div className='profileAvatarPickerHeader'>
                            <div>
                                <h2 id='profileAvatarPickerTitle' className='profileAvatarPickerTitle'>
                                    {globalize.translate('ChooseProfileImage')}
                                </h2>
                                <p className='profileAvatarPickerHelp'>
                                    {globalize.translate('ProfileImagePresetsHelp')}
                                </p>
                            </div>
                            <div className='profileAvatarScrollControls'>
                                <button
                                    type='button'
                                    className='profileAvatarScrollButton'
                                    aria-label={globalize.translate('Previous')}
                                    onClick={onPreviousAvatarPage}
                                >
                                    <span className='material-icons' aria-hidden='true'>chevron_left</span>
                                </button>
                                <button
                                    type='button'
                                    className='profileAvatarScrollButton'
                                    aria-label={globalize.translate('Next')}
                                    onClick={onNextAvatarPage}
                                >
                                    <span className='material-icons' aria-hidden='true'>chevron_right</span>
                                </button>
                            </div>
                        </div>
                        <div ref={avatarGrid} className='profileAvatarGrid'>
                            {profileAvatars.map((avatar, avatarIndex) => {
                                const avatarName = globalize.translate(avatar.nameKey);
                                return (
                                    <button
                                        key={avatar.filename}
                                        type='button'
                                        className='profileAvatarButton'
                                        aria-label={globalize.translate('UsePresetImage', avatarName)}
                                        data-avatar-index={avatarIndex}
                                        disabled={isUploadingImage}
                                        onClick={onPresetImageClick}
                                    >
                                        <img
                                            className='profileAvatarImage'
                                            src={avatar.image}
                                            alt=''
                                        />
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                )}
                <UserPasswordForm user={user} />
            </div>
        </Page>
    );
};

export default UserProfile;
