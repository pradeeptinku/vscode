/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/css!./media/runtimeExtensionsEditor';
import * as nls from 'vs/nls';
import * as os from 'os';
import product from 'vs/platform/node/product';
import URI from 'vs/base/common/uri';
import { EditorInput } from 'vs/workbench/common/editor';
import pkg from 'vs/platform/node/package';
import { TPromise } from 'vs/base/common/winjs.base';
import { Action, IAction } from 'vs/base/common/actions';
import { Builder, Dimension } from 'vs/base/browser/builder';
import { BaseEditor } from 'vs/workbench/browser/parts/editor/baseEditor';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IExtensionsWorkbenchService, IExtension } from 'vs/workbench/parts/extensions/common/extensions';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IWorkbenchEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IExtensionService, IExtensionDescription, IExtensionsStatus, IExtensionHostProfile, ProfileSession } from 'vs/platform/extensions/common/extensions';
import { IDelegate, IRenderer } from 'vs/base/browser/ui/list/list';
import { WorkbenchList, IListService } from 'vs/platform/list/browser/listService';
import { append, $, addDisposableListener, addClass } from 'vs/base/browser/dom';
import { ActionBar } from 'vs/base/browser/ui/actionbar/actionbar';
import { IMessageService, Severity } from 'vs/platform/message/common/message';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { RunOnceScheduler } from 'vs/base/common/async';
import { clipboard } from 'electron';
import { LocalExtensionType } from 'vs/platform/extensionManagement/common/extensionManagement';
import { onUnexpectedError } from 'vs/base/common/errors';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { writeFile } from 'vs/base/node/pfs';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { memoize } from 'vs/base/common/decorators';
import { StatusbarAlignment, IStatusbarRegistry, StatusbarItemDescriptor, Extensions, IStatusbarItem } from 'vs/workbench/browser/parts/statusbar/statusbar';
import { Registry } from 'vs/platform/registry/common/platform';
import { isFalsyOrEmpty } from 'vs/base/common/arrays';


interface IExtensionProfileInformation {
	/**
	 * segment when the extension was running.
	 * 2*i = segment start time
	 * 2*i+1 = segment end time
	 */
	segments: number[];
	/**
	 * total time when the extension was running.
	 * (sum of all segment lengths).
	 */
	totalTime: number;
}

interface IRuntimeExtension {
	originalIndex: number;
	description: IExtensionDescription;
	marketplaceInfo: IExtension;
	status: IExtensionsStatus;
	profileInfo: IExtensionProfileInformation;
}

export class RuntimeExtensionsEditor extends BaseEditor {

	static ID: string = 'workbench.editor.runtimeExtensions';

	private _list: WorkbenchList<IRuntimeExtension>;
	private _profileInfo: IExtensionHostProfile;

	private _elements: IRuntimeExtension[];
	private _extensionsDescriptions: IExtensionDescription[];
	private _updateSoon: RunOnceScheduler;

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IExtensionsWorkbenchService private readonly _extensionsWorkbenchService: IExtensionsWorkbenchService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IListService private readonly _listService: IListService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IMessageService private readonly _messageService: IMessageService,
		@IContextMenuService private readonly _contextMenuService: IContextMenuService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super(RuntimeExtensionsEditor.ID, telemetryService, themeService);

		this._list = null;
		this._profileInfo = null;
		this._elements = null;

		this._extensionsDescriptions = [];
		this._updateExtensions();

		this._updateSoon = this._register(new RunOnceScheduler(() => this._updateExtensions(), 200));

		this._extensionService.getExtensions().then((extensions) => {
			// We only deal with extensions with source code!
			this._extensionsDescriptions = extensions.filter((extension) => {
				return !!extension.main;
			});
			// this._profileInfo = {
			// 	startTime: 1511954813493000,
			// 	endTime: 1511954835590000,
			// 	deltas: [1000, 1500, 123456, 130, 1500, 1234, 100000],
			// 	ids: ['idle', 'self', 'vscode.git', 'vscode.emmet', 'self', 'vscode.git', 'idle'],
			// 	data: null,
			// 	getAggregatedTimes: undefined
			// };
			// this._profileInfo.endTime = this._profileInfo.startTime;
			// for (let i = 0, len = this._profileInfo.deltas.length; i < len; i++) {
			// 	this._profileInfo.endTime += this._profileInfo.deltas[i];
			// }
			this._updateExtensions();
		});
		this._register(this._extensionService.onDidChangeExtensionsStatus(() => this._updateSoon.schedule()));

		// TODO@Alex TODO@Isi ????
		// this._extensionsWorkbenchService.onChange(() => this._updateExtensions());
	}

	public setProfileInfo(profileInfo: IExtensionHostProfile): void {
		this._profileInfo = profileInfo;
		this.saveExtensionHostProfileAction.enabled = true;
		this._updateExtensions();
	}

	public getProfileInfo(): IExtensionHostProfile {
		return this._profileInfo;
	}

	private _updateExtensions(): void {
		this._elements = this._resolveExtensions();
		if (this._list) {
			this._list.splice(0, this._list.length, this._elements);
		}
	}

	private _resolveExtensions(): IRuntimeExtension[] {
		let marketplaceMap: { [id: string]: IExtension; } = Object.create(null);
		for (let extension of this._extensionsWorkbenchService.local) {
			marketplaceMap[extension.id] = extension;
		}

		let statusMap = this._extensionService.getExtensionsStatus();

		// group profile segments by extension
		let segments: { [id: string]: number[]; } = Object.create(null);

		if (this._profileInfo) {
			let currentStartTime = this._profileInfo.startTime;
			for (let i = 0, len = this._profileInfo.deltas.length; i < len; i++) {
				const id = this._profileInfo.ids[i];
				const delta = this._profileInfo.deltas[i];

				let extensionSegments = segments[id];
				if (!extensionSegments) {
					extensionSegments = [];
					segments[id] = extensionSegments;
				}

				extensionSegments.push(currentStartTime);
				currentStartTime = currentStartTime + delta;
				extensionSegments.push(currentStartTime);
			}
		}

		let result: IRuntimeExtension[] = [];
		for (let i = 0, len = this._extensionsDescriptions.length; i < len; i++) {
			const extensionDescription = this._extensionsDescriptions[i];

			let profileInfo: IExtensionProfileInformation = null;
			if (this._profileInfo) {
				let extensionSegments = segments[extensionDescription.id] || [];
				let extensionTotalTime = 0;
				for (let j = 0, lenJ = extensionSegments.length / 2; j < lenJ; j++) {
					const startTime = extensionSegments[2 * j];
					const endTime = extensionSegments[2 * j + 1];
					extensionTotalTime += (endTime - startTime);
				}
				profileInfo = {
					segments: extensionSegments,
					totalTime: extensionTotalTime
				};
			}

			result[i] = {
				originalIndex: i,
				description: extensionDescription,
				marketplaceInfo: marketplaceMap[extensionDescription.id],
				status: statusMap[extensionDescription.id],
				profileInfo: profileInfo
			};
		}

		result = result.filter((element) => element.status.activationTimes);

		if (this._profileInfo) {
			// sort descending by time spent in the profiler
			result = result.sort((a, b) => {
				if (a.profileInfo.totalTime === b.profileInfo.totalTime) {
					return a.originalIndex - b.originalIndex;
				}
				return b.profileInfo.totalTime - a.profileInfo.totalTime;
			});
		}

		return result;
	}

	protected createEditor(parent: Builder): void {
		const container = parent.getHTMLElement();

		addClass(container, 'runtime-extensions-editor');

		const TEMPLATE_ID = 'runtimeExtensionElementTemplate';

		const delegate = new class implements IDelegate<IRuntimeExtension>{
			getHeight(element: IRuntimeExtension): number {
				return 62;
			}
			getTemplateId(element: IRuntimeExtension): string {
				return TEMPLATE_ID;
			}
		};

		interface IRuntimeExtensionTemplateData {
			root: HTMLElement;
			element: HTMLElement;
			icon: HTMLImageElement;
			name: HTMLElement;

			activationTime: HTMLElement;
			profileTime: HTMLElement;

			profileTimeline: HTMLElement;

			msgIcon: HTMLElement;
			msgLabel: HTMLElement;

			actionbar: ActionBar;
			disposables: IDisposable[];
			elementDisposables: IDisposable[];
		}

		const renderer: IRenderer<IRuntimeExtension, IRuntimeExtensionTemplateData> = {
			templateId: TEMPLATE_ID,
			renderTemplate: (root: HTMLElement): IRuntimeExtensionTemplateData => {
				const element = append(root, $('.extension'));
				const icon = append(element, $<HTMLImageElement>('img.icon'));

				const desc = append(element, $('div.desc'));
				const name = append(desc, $('div.name'));

				const msgContainer = append(desc, $('div.msg'));
				const msgIcon = append(msgContainer, $('.'));
				const msgLabel = append(msgContainer, $('span.msg-label'));

				const timeContainer = append(element, $('.time'));
				const activationTime = append(timeContainer, $('div.activation-time'));
				const profileTime = append(timeContainer, $('div.profile-time'));

				const profileTimeline = append(element, $('div.profile-timeline'));

				const actionbar = new ActionBar(element, {
					animated: false
				});
				actionbar.onDidRun(({ error }) => error && this._messageService.show(Severity.Error, error));
				actionbar.push(new ReportExtensionIssueAction(), { icon: false });

				const disposables = [actionbar];

				return {
					root,
					element,
					icon,
					name,
					actionbar,
					activationTime,
					profileTime,
					profileTimeline,
					msgIcon,
					msgLabel,
					disposables,
					elementDisposables: []
				};
			},

			renderElement: (element: IRuntimeExtension, index: number, data: IRuntimeExtensionTemplateData): void => {

				data.elementDisposables = dispose(data.elementDisposables);

				data.elementDisposables.push(
					addDisposableListener(data.icon, 'error', () => {
						data.icon.src = element.marketplaceInfo.iconUrlFallback;
					})
				);
				data.icon.src = element.marketplaceInfo.iconUrl;

				data.name.textContent = element.marketplaceInfo.displayName;

				const activationTimes = element.status.activationTimes;
				let syncTime = activationTimes.codeLoadingTime + activationTimes.activateCallTime;
				data.activationTime.textContent = activationTimes.startup ? `Startup Activation: ${syncTime}ms` : `Activation: ${syncTime}ms`;
				data.actionbar.context = element;

				let title: string;
				if (activationTimes.activationEvent === '*') {
					title = nls.localize('starActivation', "Activated on start-up");
				} else if (/^workspaceContains:/.test(activationTimes.activationEvent)) {
					let fileNameOrGlob = activationTimes.activationEvent.substr('workspaceContains:'.length);
					if (fileNameOrGlob.indexOf('*') >= 0 || fileNameOrGlob.indexOf('?') >= 0) {
						title = nls.localize('workspaceContainsGlobActivation', "Activated because a file matching {0} exists in your workspace", fileNameOrGlob);
					} else {
						title = nls.localize('workspaceContainsFileActivation', "Activated because file {0} exists in your workspace", fileNameOrGlob);
					}
				} else if (/^onLanguage:/.test(activationTimes.activationEvent)) {
					let language = activationTimes.activationEvent.substr('onLanguage:'.length);
					title = nls.localize('languageActivation', "Activated because you opened a {0} file", language);
				} else {
					title = nls.localize('workspaceGenericActivation', "Activated on {0}", activationTimes.activationEvent);
				}
				data.activationTime.title = title;
				if (!isFalsyOrEmpty(element.status.runtimeErrors)) {
					data.msgIcon.className = 'octicon octicon-bug';
					data.msgLabel.textContent = nls.localize('errors', "{0} uncaught errors", element.status.runtimeErrors.length);
				} else if (element.status.messages && element.status.messages.length > 0) {
					data.msgIcon.className = 'octicon octicon-alert';
					data.msgLabel.textContent = element.status.messages[0].message;
				} else {
					data.msgIcon.className = '';
					data.msgLabel.textContent = '';
				}

				if (this._profileInfo) {
					data.profileTime.textContent = `Profile: ${(element.profileInfo.totalTime / 1000).toFixed(2)}ms`;
					const elementSegments = element.profileInfo.segments;
					let inner = '<rect x="0" y="99" width="100" height="1" />';
					for (let i = 0, len = elementSegments.length / 2; i < len; i++) {
						const absoluteStart = elementSegments[2 * i];
						const absoluteEnd = elementSegments[2 * i + 1];

						const start = absoluteStart - this._profileInfo.startTime;
						const end = absoluteEnd - this._profileInfo.startTime;

						const absoluteDuration = this._profileInfo.endTime - this._profileInfo.startTime;

						const xStart = start / absoluteDuration * 100;
						const xEnd = end / absoluteDuration * 100;

						inner += `<rect x="${xStart}" y="0" width="${xEnd - xStart}" height="100" />`;
					}
					let svg = `<svg class="profile-timeline-svg" preserveAspectRatio="none" height="16" viewBox="0 0 100 100">${inner}</svg>`;

					data.profileTimeline.innerHTML = svg;
					data.profileTimeline.style.display = 'inherit';
				} else {
					data.profileTime.textContent = '';
					data.profileTimeline.innerHTML = '';
				}
			},

			disposeTemplate: (data: IRuntimeExtensionTemplateData): void => {
				data.disposables = dispose(data.disposables);
			}
		};

		this._list = new WorkbenchList<IRuntimeExtension>(container, delegate, [renderer], {
			multipleSelectionSupport: false
		}, this._contextKeyService, this._listService, this.themeService);

		this._list.splice(0, this._list.length, this._elements);

		this._list.onContextMenu((e) => {
			const actions: IAction[] = [];

			actions.push(this.saveExtensionHostProfileAction, this.extensionHostProfileAction);

			this._contextMenuService.showContextMenu({
				getAnchor: () => e.anchor,
				getActions: () => TPromise.as(actions)
			});
		});
	}

	public getActions(): IAction[] {
		return [
			this.saveExtensionHostProfileAction,
			this.extensionHostProfileAction
		];
	}

	@memoize
	private get extensionHostProfileAction(): IAction {
		return this._instantiationService.createInstance(ExtensionHostProfileAction, ExtensionHostProfileAction.ID, ExtensionHostProfileAction.LABEL_START, this);
	}

	@memoize
	private get saveExtensionHostProfileAction(): IAction {
		return this._instantiationService.createInstance(SaveExtensionHostProfileAction, SaveExtensionHostProfileAction.ID, SaveExtensionHostProfileAction.LABEL, this);
	}

	public layout(dimension: Dimension): void {
		this._list.layout(dimension.height);
	}
}

export class RuntimeExtensionsInput extends EditorInput {

	static ID = 'workbench.runtimeExtensions.input';

	constructor() {
		super();
	}

	getTypeId(): string {
		return RuntimeExtensionsInput.ID;
	}

	getName(): string {
		return nls.localize('extensionsInputName', "Running Extensions");
	}

	matches(other: any): boolean {
		if (!(other instanceof RuntimeExtensionsInput)) {
			return false;
		}
		return true;
	}

	resolve(refresh?: boolean): TPromise<any> {
		return TPromise.as(null);
	}

	supportsSplitEditor(): boolean {
		return false;
	}

	getResource(): URI {
		return URI.from({
			scheme: 'runtime-extensions',
			path: 'default'
		});
	}
}

export class ShowRuntimeExtensionsAction extends Action {
	static ID = 'workbench.action.showRuntimeExtensions';
	static LABEL = nls.localize('showRuntimeExtensions', "Show Running Extensions");

	constructor(
		id: string, label: string,
		@IWorkbenchEditorService private readonly _editorService: IWorkbenchEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super(id, label);
	}

	public run(e?: any): TPromise<any> {
		return this._editorService.openEditor(this._instantiationService.createInstance(RuntimeExtensionsInput));
	}
}

class ReportExtensionIssueAction extends Action {
	static ID = 'workbench.extensions.action.reportExtensionIssue';
	static LABEL = nls.localize('reportExtensionIssue', "Report Issue");

	constructor(
		id: string = ReportExtensionIssueAction.ID, label: string = ReportExtensionIssueAction.LABEL
	) {
		super(id, label, 'report-extension-issue');
	}

	run(extension: IRuntimeExtension): TPromise<any> {
		clipboard.writeText('```json \n' + JSON.stringify(extension.status, null, '\t') + '\n```');
		window.open(this.generateNewIssueUrl(extension));

		return TPromise.as(null);
	}

	private generateNewIssueUrl(extension: IRuntimeExtension): string {
		const baseUrl = extension.marketplaceInfo.type === LocalExtensionType.User && extension.description.repository && extension.description.repository.url ?
			`${extension.description.repository.url.substr(0, extension.description.repository.url.length - 4)}/issues/new/`
			: product.reportIssueUrl;
		const osVersion = `${os.type()} ${os.arch()} ${os.release()}`;
		const queryStringPrefix = baseUrl.indexOf('?') === -1 ? '?' : '&';
		const body = encodeURIComponent(
			`- Extension Name: ${extension.description.name}
- Extension Version: ${extension.description.version}
- OS Version: ${osVersion}
- VSCode version: ${pkg.version}` + '\n\n We have written the needed data into your clipboard. Please paste:'
		);

		return `${baseUrl}${queryStringPrefix}body=${body}`;
	}
}

const enum ProfileSessionState {
	None = 0,
	Starting = 1,
	Running = 2,
	Stopping = 3
}

class ExtensionHostProfileAction extends Action {
	static ID = 'workbench.extensions.action.extensionHostProfile';
	static LABEL_START = nls.localize('extensionHostProfileStart', "Start Extension Host Profile");
	static LABEL_STOP = nls.localize('extensionHostProfileStop', "Stop Extension Host Profile");
	static STOP_CSS_CLASS = 'extension-host-profile-stop';
	static START_CSS_CLASS = 'extension-host-profile-start';

	private _profileSession: ProfileSession;
	private _state: ProfileSessionState;

	constructor(
		id: string = ExtensionHostProfileAction.ID, label: string = ExtensionHostProfileAction.LABEL_START,
		private readonly _parentEditor: RuntimeExtensionsEditor,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IWorkbenchEditorService private readonly _editorService: IWorkbenchEditorService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super(id, label, ExtensionHostProfileAction.START_CSS_CLASS);
		this._profileSession = null;
		this._setState(ProfileSessionState.None);
	}

	private update(): void {
		if (this._profileSession) {
			this.class = ExtensionHostProfileAction.STOP_CSS_CLASS;
			this.label = ExtensionHostProfileAction.LABEL_STOP;
			ProfileExtHostStatusbarItem.instance.show(() => {
				this.run();
				this._editorService.openEditor(this._instantiationService.createInstance(RuntimeExtensionsInput));
			});
		} else {
			this.class = ExtensionHostProfileAction.START_CSS_CLASS;
			this.label = ExtensionHostProfileAction.LABEL_START;
			ProfileExtHostStatusbarItem.instance.hide();
		}
	}

	private _setState(state: ProfileSessionState): void {
		this._state = state;
		this.update();
	}

	run(): TPromise<any> {
		switch (this._state) {
			case ProfileSessionState.None:
				this._setState(ProfileSessionState.Starting);
				this._extensionService.startExtensionHostProfile().then((value) => {
					this._profileSession = value;
					this._setState(ProfileSessionState.Running);
				}, (err) => {
					onUnexpectedError(err);
					this._setState(ProfileSessionState.None);
				});
				break;
			case ProfileSessionState.Starting:
				break;
			case ProfileSessionState.Running:
				this._setState(ProfileSessionState.Stopping);
				this._profileSession.stop().then((result) => {
					this._parentEditor.setProfileInfo(result);
					this._setState(ProfileSessionState.None);
				}, (err) => {
					onUnexpectedError(err);
					this._setState(ProfileSessionState.None);
				});
				this._profileSession = null;
				break;
			case ProfileSessionState.Stopping:
				break;
		}

		return TPromise.as(null);
	}
}

class SaveExtensionHostProfileAction extends Action {

	static LABEL = nls.localize('saveExtensionHostProfile', "Save Extension Host Profile");
	static ID = 'workbench.extensions.action.saveExtensionHostProfile';

	constructor(
		id: string = SaveExtensionHostProfileAction.ID, label: string = SaveExtensionHostProfileAction.LABEL,
		private readonly _parentEditor: RuntimeExtensionsEditor,
		@IWindowService private readonly _windowService: IWindowService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
		super(id, label, 'save-extension-host-profile', false);
	}

	async run(): TPromise<any> {
		let picked = this._windowService.showSaveDialog({
			title: 'Save Extension Host Profile',
			buttonLabel: 'Save',
			defaultPath: `CPU-${new Date().toISOString().replace(/[\-:]/g, '')}.cpuprofile`,
			filters: [{
				name: 'CPU Profiles',
				extensions: ['cpuprofile', 'txt']
			}]
		});

		if (!picked) {
			return;
		}

		const profileInfo = this._parentEditor.getProfileInfo();
		let dataToWrite: object = profileInfo.data;

		if (this._environmentService.isBuilt) {
			const profiler = await import('v8-inspect-profiler');
			// when running from a not-development-build we remove
			// absolute filenames because we don't want to reveal anything
			// about users. We also append the `.txt` suffix to make it
			// easier to attach these files to GH issues

			let tmp = profiler.rewriteAbsolutePaths({ profile: dataToWrite }, 'piiRemoved');
			dataToWrite = tmp.profile;

			picked = picked + '.txt';
		}

		return writeFile(picked, JSON.stringify(profileInfo.data, null, '\t'));
	}
}

export class ProfileExtHostStatusbarItem implements IStatusbarItem {

	public static instance: ProfileExtHostStatusbarItem;

	private toDispose: IDisposable[];
	private statusBarItem: HTMLElement;
	private label: HTMLElement;
	private timeStarted: number;
	private labelUpdater: number;
	private clickHandler: () => void;

	constructor() {
		ProfileExtHostStatusbarItem.instance = this;
		this.toDispose = [];
	}

	public show(clickHandler: () => void) {
		this.clickHandler = clickHandler;
		if (this.timeStarted === 0) {
			this.timeStarted = new Date().getTime();
			this.statusBarItem.hidden = false;
			this.labelUpdater = setInterval(() => {
				this.updateLabel();
			}, 1000);
		}
	}

	public hide() {
		this.clickHandler = null;
		this.statusBarItem.hidden = true;
		this.timeStarted = 0;
		clearInterval(this.labelUpdater);
		this.labelUpdater = null;
	}

	public render(container: HTMLElement): IDisposable {
		if (!this.statusBarItem && container) {
			this.statusBarItem = append(container, $('.profileExtHost-statusbar-item'));
			this.toDispose.push(addDisposableListener(this.statusBarItem, 'click', () => {
				if (this.clickHandler) {
					this.clickHandler();
				}
			}));
			this.statusBarItem.title = nls.localize('selectAndStartDebug', "Click to stop profiling.");
			const a = append(this.statusBarItem, $('a'));
			append(a, $('.icon'));
			this.label = append(a, $('span.label'));
			this.updateLabel();
			this.statusBarItem.hidden = true;
		}
		return this;
	}

	private updateLabel() {
		let label = 'Profiling Extension Host';
		if (this.timeStarted > 0) {
			let secondsRecoreded = (new Date().getTime() - this.timeStarted) / 1000;
			label = `Profiling Extension Host (${Math.round(secondsRecoreded)} sec)`;
		}
		this.label.textContent = label;
	}

	public dispose(): void {
		this.toDispose = dispose(this.toDispose);
	}
}

Registry.as<IStatusbarRegistry>(Extensions.Statusbar).registerStatusbarItem(
	new StatusbarItemDescriptor(ProfileExtHostStatusbarItem, StatusbarAlignment.RIGHT)
);
