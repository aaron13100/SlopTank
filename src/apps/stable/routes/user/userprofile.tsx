import type { UserDto } from '@jellyfin/sdk/lib/generated-client';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import React, { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import astronautHelmet from 'assets/img/profile-avatars/astronaut-helmet.png';
import bicycleHelmet from 'assets/img/profile-avatars/bicycle-helmet.png';
import blackCat from 'assets/img/profile-avatars/black-cat.png';
import bonsaiTree from 'assets/img/profile-avatars/bonsai-tree.png';
import bookStack from 'assets/img/profile-avatars/book-stack.png';
import boulderingShoe from 'assets/img/profile-avatars/bouldering-shoe.png';
import burrito from 'assets/img/profile-avatars/burrito.png';
import camera from 'assets/img/profile-avatars/camera.png';
import cowboyBoot from 'assets/img/profile-avatars/cowboy-boot.png';
import electricGuitar from 'assets/img/profile-avatars/electric-guitar.png';
import espresso from 'assets/img/profile-avatars/espresso.png';
import gameController from 'assets/img/profile-avatars/game-controller.png';
import knittingYarn from 'assets/img/profile-avatars/knitting-yarn.png';
import magicalWand from 'assets/img/profile-avatars/magical-wand.png';
import mushroom from 'assets/img/profile-avatars/mushroom.png';
import ramenBowl from 'assets/img/profile-avatars/ramen-bowl.png';
import rubberDuck from 'assets/img/profile-avatars/rubber-duck.png';
import samuraiHelmet from 'assets/img/profile-avatars/samurai-helmet.png';
import skateboard from 'assets/img/profile-avatars/skateboard.png';
import skull from 'assets/img/profile-avatars/skull.png';
import swimGoggles from 'assets/img/profile-avatars/swim-goggles.png';
import taikoDrum from 'assets/img/profile-avatars/taiko-drum.png';
import telescope from 'assets/img/profile-avatars/telescope.png';
import twentySidedDie from 'assets/img/profile-avatars/twenty-sided-die.png';
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
    { filename: 'samurai-helmet.png', image: samuraiHelmet, nameKey: 'AvatarSamuraiHelmet' },
    { filename: 'magical-wand.png', image: magicalWand, nameKey: 'AvatarAnimeMagicWand' },
    { filename: 'knitting-yarn.png', image: knittingYarn, nameKey: 'AvatarKnittingYarn' },
    { filename: 'swim-goggles.png', image: swimGoggles, nameKey: 'AvatarSwimGoggles' },
    { filename: 'skull.png', image: skull, nameKey: 'AvatarSkull' },
    { filename: 'burrito.png', image: burrito, nameKey: 'AvatarBurrito' },
    { filename: 'taiko-drum.png', image: taikoDrum, nameKey: 'AvatarTaikoDrum' },
    { filename: 'bouldering-shoe.png', image: boulderingShoe, nameKey: 'AvatarBoulderingShoe' },
    { filename: 'ramen-bowl.png', image: ramenBowl, nameKey: 'AvatarRamenBowl' },
    { filename: 'game-controller.png', image: gameController, nameKey: 'AvatarGameController' },
    { filename: 'twenty-sided-die.png', image: twentySidedDie, nameKey: 'AvatarTwentySidedDie' },
    { filename: 'electric-guitar.png', image: electricGuitar, nameKey: 'AvatarElectricGuitar' },
    { filename: 'black-cat.png', image: blackCat, nameKey: 'AvatarBlackCat' },
    { filename: 'mushroom.png', image: mushroom, nameKey: 'AvatarMushroom' },
    { filename: 'telescope.png', image: telescope, nameKey: 'AvatarTelescope' },
    { filename: 'astronaut-helmet.png', image: astronautHelmet, nameKey: 'AvatarAstronautHelmet' },
    { filename: 'skateboard.png', image: skateboard, nameKey: 'AvatarSkateboard' },
    { filename: 'espresso.png', image: espresso, nameKey: 'AvatarEspresso' },
    { filename: 'bonsai-tree.png', image: bonsaiTree, nameKey: 'AvatarBonsaiTree' },
    { filename: 'rubber-duck.png', image: rubberDuck, nameKey: 'AvatarRubberDuck' },
    { filename: 'cowboy-boot.png', image: cowboyBoot, nameKey: 'AvatarCowboyBoot' },
    { filename: 'camera.png', image: camera, nameKey: 'AvatarCamera' },
    { filename: 'book-stack.png', image: bookStack, nameKey: 'AvatarBookStack' },
    { filename: 'bicycle-helmet.png', image: bicycleHelmet, nameKey: 'AvatarBicycleHelmet' }
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
