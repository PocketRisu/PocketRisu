/**
 * Curated lucide icons a folder can use instead of the default folder glyph
 * (`folder.nodeOnlyIcon`). Explicit imports keep the bundle to just these;
 * an unknown name (e.g. from a newer version) falls back to the default.
 */
import type { Component } from 'svelte'
import {
    FolderIcon, FolderHeartIcon, StarIcon, HeartIcon, SparklesIcon, FlameIcon, SunIcon, MoonIcon, CloudIcon, ZapIcon,
    CrownIcon, GemIcon, GiftIcon, CakeIcon, CoffeeIcon, PizzaIcon, MusicIcon, Gamepad2Icon, SwordIcon, ShieldIcon,
    WandSparklesIcon, GhostIcon, SkullIcon, CatIcon, DogIcon, BirdIcon, FishIcon, RabbitIcon, BugIcon, FlowerIcon,
    LeafIcon, TreePineIcon, MountainIcon, RocketIcon, PlaneIcon, CarIcon, HouseIcon, Building2Icon, CastleIcon,
    BookOpenIcon, GraduationCapIcon, BriefcaseIcon, BotIcon, CpuIcon, GlobeIcon, MapPinIcon, CameraIcon, PaletteIcon,
    SmileIcon, UsersIcon, UserIcon, BabyIcon, BookmarkIcon, TagIcon, ClockIcon, CalendarIcon, ArchiveIcon, PinIcon,
} from '@lucide/svelte'

export const FOLDER_ICONS: Record<string, Component<any>> = {
    folder: FolderIcon, 'folder-heart': FolderHeartIcon, star: StarIcon, heart: HeartIcon, sparkles: SparklesIcon,
    flame: FlameIcon, sun: SunIcon, moon: MoonIcon, cloud: CloudIcon, zap: ZapIcon, crown: CrownIcon, gem: GemIcon,
    gift: GiftIcon, cake: CakeIcon, coffee: CoffeeIcon, pizza: PizzaIcon, music: MusicIcon, gamepad: Gamepad2Icon,
    sword: SwordIcon, shield: ShieldIcon, wand: WandSparklesIcon, ghost: GhostIcon, skull: SkullIcon, cat: CatIcon,
    dog: DogIcon, bird: BirdIcon, fish: FishIcon, rabbit: RabbitIcon, bug: BugIcon, flower: FlowerIcon, leaf: LeafIcon,
    tree: TreePineIcon, mountain: MountainIcon, rocket: RocketIcon, plane: PlaneIcon, car: CarIcon, house: HouseIcon,
    building: Building2Icon, castle: CastleIcon, book: BookOpenIcon, graduation: GraduationCapIcon,
    briefcase: BriefcaseIcon, bot: BotIcon, cpu: CpuIcon, globe: GlobeIcon, pin: MapPinIcon, camera: CameraIcon,
    palette: PaletteIcon, smile: SmileIcon, users: UsersIcon, user: UserIcon, baby: BabyIcon, bookmark: BookmarkIcon,
    tag: TagIcon, clock: ClockIcon, calendar: CalendarIcon, archive: ArchiveIcon, pushpin: PinIcon,
}

export const FOLDER_ICON_NAMES = Object.keys(FOLDER_ICONS)

export function folderIconComponent(name: string | undefined): Component<any> | undefined {
    return name ? FOLDER_ICONS[name] : undefined
}
