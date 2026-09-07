import {faClone, faFolderPlus, faPen, faPlus, faShareNodes, faSliders, faXmark} from '@fortawesome/free-solid-svg-icons';
import {ContextMenuItem} from '@src/Components/Planner/ContextMenu/ContextMenuItem';
import {PlannerContextMenu} from '@src/Components/Planner/ContextMenu/PlannerContextMenu';
import {PlanTreeMenuHost} from '@src/Components/Planner/Panels/Plans/PlanTreeMenuHost';

/**
 * Context menu shown when right-clicking a folder row in the Plans tree.
 */
export class FolderContextMenu extends PlannerContextMenu
{

	public constructor(
		private readonly folderId: string,
		private readonly folderName: string,
		private readonly host: PlanTreeMenuHost,
	)
	{
		super();
	}

	public override getTitle(): string
	{
		return this.folderName;
	}

	public getItems(): ContextMenuItem[]
	{
		const items: ContextMenuItem[] = [
			{
				label: 'Rename…',
				icon: faPen,
				action: () => this.host.startRenameFolder(this.folderId, this.folderName),
			},
			this.customSettingsItem(),
			{
				label: 'New subfolder…',
				icon: faFolderPlus,
				action: () => this.host.startCreateFolder(this.folderId),
			},
			{
				label: 'New plan…',
				icon: faPlus,
				action: () => this.host.startCreatePlan(this.folderId),
			},
			{
				label: 'Clone folder',
				icon: faClone,
				action: () => this.host.cloneFolder(this.folderId),
			},
		];

		if (this.host.canShare()) {
			items.push({
				label: 'Share…',
				icon: faShareNodes,
				action: () => this.host.shareFolder(this.folderId, this.folderName),
			});
		}

		items.push({
			label: 'Delete folder',
			icon: faXmark,
			action: () => this.host.deleteFolder(this.folderId, this.folderName),
		});

		return items;
	}

	/**
	 * Toggle the folder's own solver settings. These become the defaults for
	 * new plans/subfolders and can then be switched to Fixed or a shared /
	 * parallel Resources pool. Disabled (not hidden) when a parent folder
	 * already fixes settings, so the option stays discoverable.
	 */
	private customSettingsItem(): ContextMenuItem
	{
		if (this.host.folderHasCustomSettings(this.folderId)) {
			return {
				label: 'Remove custom settings',
				icon: faSliders,
				action: () => this.host.removeFolderCustomSettings(this.folderId, this.folderName),
			};
		}
		return {
			label: 'Give custom settings',
			icon: faSliders,
			disabled: this.host.folderCustomSettingsBlocker(this.folderId) !== null,
			action: () => this.host.giveFolderCustomSettings(this.folderId),
		};
	}

}
