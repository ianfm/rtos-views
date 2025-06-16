/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import * as RTOSCommon from './rtos-common';

// RTX v4 thread display fields
enum DisplayFields {
    ID,
    Address,
    TaskName,
    Status,
    Priority,
    StackStart,
    StackTop,
    StackSize,
    StackUsed,
    StackFree,
    StackPeak
}

const numType = RTOSCommon.ColTypeEnum.colTypeNumeric;
const RTX4Items: { [key: string]: RTOSCommon.DisplayColumnItem } = {};
RTX4Items[DisplayFields[DisplayFields.ID]] = { width: 1, headerRow1: '', headerRow2: 'ID', colType: numType };
RTX4Items[DisplayFields[DisplayFields.Address]] = {
    width: 3,
    headerRow1: 'Thread',
    headerRow2: 'Address',
    colGapBefore: 1
};
RTX4Items[DisplayFields[DisplayFields.TaskName]] = { width: 4, headerRow1: '', headerRow2: 'Task Name' };
RTX4Items[DisplayFields[DisplayFields.Status]] = { width: 3, headerRow1: '', headerRow2: 'Status' };
RTX4Items[DisplayFields[DisplayFields.Priority]] = {
    width: 1.5,
    headerRow1: 'Prio',
    headerRow2: 'rity',
    colType: numType
};
RTX4Items[DisplayFields[DisplayFields.StackStart]] = {
    width: 3,
    headerRow1: 'Stack',
    headerRow2: 'Start',
    colType: RTOSCommon.ColTypeEnum.colTypeLink,
    colGapBefore: 1
};
RTX4Items[DisplayFields[DisplayFields.StackTop]] = { width: 3, headerRow1: 'Stack', headerRow2: 'Top' };
RTX4Items[DisplayFields[DisplayFields.StackSize]] = {
    width: 2,
    headerRow1: 'Stack',
    headerRow2: 'Size',
    colType: numType
};
RTX4Items[DisplayFields[DisplayFields.StackUsed]] = {
    width: 2,
    headerRow1: 'Stack',
    headerRow2: 'Used',
    colType: numType
};
RTX4Items[DisplayFields[DisplayFields.StackFree]] = {
    width: 2,
    headerRow1: 'Stack',
    headerRow2: 'Free',
    colType: numType
};
RTX4Items[DisplayFields[DisplayFields.StackPeak]] = {
    width: 2,
    headerRow1: 'Stack',
    headerRow2: 'Peak',
    colType: numType
};
const DisplayFieldNames: string[] = Object.keys(RTX4Items);

export class RTOSRTX4 extends RTOSCommon.RTOSBase {
    // RTX v4 global variables and references
    private osRunning: RTOSCommon.RTOSVarHelperMaybe;
    private osTask: RTOSCommon.RTOSVarHelperMaybe;
    private osTaskCurrent: RTOSCommon.RTOSVarHelperMaybe;
    private osTaskCount: RTOSCommon.RTOSVarHelperMaybe;

    private stale = true;
    private foundThreads: RTOSCommon.RTOSThreadInfo[] = [];
    private finalThreads: RTOSCommon.RTOSThreadInfo[] = [];
    private timeInfo = '';
    private readonly maxThreads = 256;
    private helpHtml: string | undefined;

    // Stack growth direction (-1 for downward, 1 for upward)
    private stackIncrements = -1;
    private stackPattern = 0xCCCCCCCC; // Default stack fill pattern

    constructor(public session: vscode.DebugSession) {
        super(session, 'RTX v4');

        // Check for RTX configuration from debug session
        if (session.configuration.rtosViewConfig) {
            if (session.configuration.rtosViewConfig.stackPattern) {
                this.stackPattern = parseInt(session.configuration.rtosViewConfig.stackPattern);
            }
            if (session.configuration.rtosViewConfig.stackGrowth) {
                this.stackIncrements = parseInt(session.configuration.rtosViewConfig.stackGrowth);
            }
        }
    }

    public async tryDetect(useFrameId: number): Promise<RTOSCommon.RTOSBase> {
        this.progStatus = 'stopped';
        try {
            if (this.status === 'none') {
                // Try to detect RTX v4 by looking for key global variables
                // RTX v4 typically has variables like os_running, os_tsk, etc.

                // RTX v4 specific variables based on your build
                this.osRunning = await this.getVarIfEmpty(
                    this.osRunning,
                    useFrameId,
                    'os_running',
                    true
                );

                // Main task structure
                this.osTask = await this.getVarIfEmpty(
                    this.osTask,
                    useFrameId,
                    'os_tsk',
                    true
                );

                this.osTaskCurrent = await this.getVarIfEmpty(
                    this.osTaskCurrent,
                    useFrameId,
                    'os_tsk_current',
                    true
                );

                this.osTaskCount = await this.getVarIfEmpty(
                    this.osTaskCount,
                    useFrameId,
                    'os_tsk_count',
                    true
                );

                // We need at least one of these variables to detect RTX v4
                if (!this.osRunning && !this.osTask && !this.osTaskCurrent) {
                    throw new Error('RTX v4 not detected - no recognizable global variables found');
                }

                this.status = 'initialized';
            }
            return this;
        } catch (e) {
            if (e instanceof RTOSCommon.ShouldRetry) {
                console.error(e.message);
            } else {
                this.status = 'failed';
                this.failedWhy = e;
            }
            return this;
        }
    }

    public refresh(frameId: number): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.progStatus !== 'stopped') {
                resolve();
                return;
            }

            const timer = new RTOSCommon.HrTimer();
            this.stale = true;
            this.timeInfo = new Date().toISOString();
            this.foundThreads = [];

            // Start the refresh process
            this.refreshRTXInfo(frameId).then(
                () => {
                    this.stale = false;
                    this.timeInfo += ' in ' + timer.deltaMs() + ' ms';
                    resolve();
                },
                (reason) => {
                    resolve();
                    console.error('RTX v4 refresh() failed: ', reason);
                }
            );
        });
    }

    private async refreshRTXInfo(frameId: number): Promise<void> {
        try {
            console.log('RTX v4: Starting refresh...');

            // Get current running task from os_tsk.run
            if (this.osTask) {
                console.log('RTX v4: Trying to get os_tsk info...');
                const osTaskObj = await this.osTask.getVarChildrenObj(frameId);
                console.log('RTX v4: os_tsk object:', osTaskObj);

                if (osTaskObj && osTaskObj['run']) {
                    const currentTaskAddr = parseInt(osTaskObj['run'].val);
                    console.log('RTX v4: Current task address:', RTOSCommon.hexFormat(currentTaskAddr));
                    if (currentTaskAddr && currentTaskAddr !== 0) {
                        // Mark this as the running task
                        await this.getTaskInfo(currentTaskAddr, frameId, true);
                    }
                } else {
                    console.log('RTX v4: No run field in os_tsk or os_tsk is null');
                }
            } else {
                console.log('RTX v4: osTask is null, trying alternative detection...');
            }

            // Try to get all active tasks (simplified approach)
            await this.getAllActiveTasks(frameId);

            console.log(`RTX v4: Found ${this.foundThreads.length} threads`);

            // Sort threads by task ID or address
            if (this.foundThreads.length > 0) {
                const firstThread = this.foundThreads[0];
                if (firstThread.display['ID'] && firstThread.display['ID'].text !== '??') {
                    this.foundThreads.sort(
                        (a, b) => parseInt(a.display['ID'].text) - parseInt(b.display['ID'].text)
                    );
                } else {
                    this.foundThreads.sort(
                        (a, b) => parseInt(a.display['Address'].text) - parseInt(b.display['Address'].text)
                    );
                }
            }

            this.finalThreads = [...this.foundThreads];
            console.log('RTX v4: Refresh completed successfully');
        } catch (e) {
            console.error('RTX v4 refreshRTXInfo() failed: ', e);
            throw e;
        }
    }

    private async getAllActiveTasks(frameId: number): Promise<void> {
        // Access os_active_TCB[8] array to get all active tasks
        try {
            console.log('RTX v4: Trying to get os_active_TCB array...');

            // Your build has os_active_TCB[8], so we'll iterate through each slot
            for (let i = 0; i < 8; i++) {
                try {
                    const tcbExpr = `os_active_TCB[${i}]`;
                    const tcbValue = await this.getExprVal(tcbExpr, frameId);
                    console.log(`RTX v4: os_active_TCB[${i}] = ${tcbValue}`);

                    if (tcbValue && tcbValue !== '0x0' && tcbValue !== 'NULL' && tcbValue !== '(void *) 0x0') {
                        const taskAddr = parseInt(tcbValue);
                        if (taskAddr && taskAddr !== 0) {
                            console.log(`RTX v4: Processing task at ${RTOSCommon.hexFormat(taskAddr)}`);
                            await this.getTaskInfo(taskAddr, frameId, false);
                        }
                    }
                } catch (e) {
                    console.log(`RTX v4: Failed to get os_active_TCB[${i}]:`, e);
                }
            }
        } catch (e) {
            console.log('RTX v4: Failed to access os_active_TCB array:', e);
        }
    }

    private async getTaskInfo(taskAddr: number, frameId: number, isRunning: boolean): Promise<void> {
        try {
            console.log(`RTX v4: Getting task info for ${RTOSCommon.hexFormat(taskAddr)}, running=${isRunning}`);

            // Get task control block information by casting the address to OS_TCB pointer
            const tcbExpr = `*(struct OS_TCB*)${RTOSCommon.hexFormat(taskAddr)}`;
            console.log(`RTX v4: Evaluating expression: ${tcbExpr}`);

            const tcbVar = new RTOSCommon.RTOSVarHelper(tcbExpr, this);
            const tcbInfo = await tcbVar.getVarChildrenObj(frameId);
            console.log('RTX v4: TCB info:', tcbInfo);

            if (tcbInfo) {
                const threadInfo = await this.createThreadInfo(tcbInfo, frameId, isRunning, taskAddr);
                if (threadInfo) {
                    console.log('RTX v4: Created thread info:', threadInfo.display);
                    this.foundThreads.push(threadInfo);
                } else {
                    console.log('RTX v4: Failed to create thread info');
                }
            } else {
                console.log('RTX v4: No TCB info available');
            }
        } catch (e) {
            console.log(`RTX v4: Failed to get task info for address ${RTOSCommon.hexFormat(taskAddr)}:`, e);
        }
    }

    private async createThreadInfo(
        tcbInfo: RTOSCommon.RTOSStrToValueMap,
        _frameId: number,
        isRunning: boolean,
        taskAddr?: number
    ): Promise<RTOSCommon.RTOSThreadInfo | null> {
        try {
            const display: { [key: string]: RTOSCommon.DisplayRowItem } = {};

            // Task ID
            const taskId = tcbInfo['task_id']?.val || '??';
            display[DisplayFields[DisplayFields.ID]] = { text: taskId };

            // Task Address
            const address = taskAddr ? RTOSCommon.hexFormat(taskAddr) : (tcbInfo['address']?.val || '??');
            display[DisplayFields[DisplayFields.Address]] = { text: address };

            // Task Name - RTX v4 doesn't have built-in task names, so we'll use the task function pointer
            const taskFunc = tcbInfo['ptask']?.val || 'Unknown';
            display[DisplayFields[DisplayFields.TaskName]] = { text: taskFunc };

            // Task Status
            const state = parseInt(tcbInfo['state']?.val || '0');
            let statusText = 'Unknown';
            switch (state) {
                case 0: statusText = 'INACTIVE'; break;
                case 1: statusText = 'READY'; break;
                case 2: statusText = isRunning ? 'RUNNING' : 'READY'; break;
                case 3: statusText = 'WAIT_DLY'; break;
                case 4: statusText = 'WAIT_ITV'; break;
                case 5: statusText = 'WAIT_OR'; break;
                case 6: statusText = 'WAIT_AND'; break;
                case 7: statusText = 'WAIT_SEM'; break;
                case 8: statusText = 'WAIT_MBX'; break;
                case 9: statusText = 'WAIT_MUT'; break;
                default: statusText = `State ${state}`;
            }
            display[DisplayFields[DisplayFields.Status]] = { text: statusText };

            // Priority
            const priority = tcbInfo['prio']?.val || '??';
            display[DisplayFields[DisplayFields.Priority]] = { text: priority };

            // Stack information
            const stackInfo = await this.getStackInfo(tcbInfo);
            display[DisplayFields[DisplayFields.StackStart]] = {
                text: stackInfo.stackStart ? RTOSCommon.hexFormat(stackInfo.stackStart) : '??'
            };
            display[DisplayFields[DisplayFields.StackTop]] = {
                text: stackInfo.stackTop ? RTOSCommon.hexFormat(stackInfo.stackTop) : '??'
            };
            display[DisplayFields[DisplayFields.StackSize]] = {
                text: stackInfo.stackSize ? stackInfo.stackSize.toString() : '??'
            };
            display[DisplayFields[DisplayFields.StackUsed]] = {
                text: stackInfo.stackUsed ? stackInfo.stackUsed.toString() : '??'
            };
            display[DisplayFields[DisplayFields.StackFree]] = {
                text: stackInfo.stackFree ? stackInfo.stackFree.toString() : '??'
            };
            display[DisplayFields[DisplayFields.StackPeak]] = {
                text: stackInfo.stackPeak ? stackInfo.stackPeak.toString() : '??'
            };

            const threadInfo: RTOSCommon.RTOSThreadInfo = {
                display: display,
                stackInfo: stackInfo,
                running: isRunning
            };

            return threadInfo;
        } catch (e) {
            console.log('Failed to create thread info:', e);
            return null;
        }
    }

    private async getStackInfo(tcbInfo: RTOSCommon.RTOSStrToValueMap): Promise<RTOSCommon.RTOSStackInfo> {
        // RTX v4 stack information from OS_TCB structure
        const tskStack = tcbInfo['tsk_stack']?.val;  // Current stack pointer (R13)
        const stack = tcbInfo['stack']?.val;         // Pointer to stack memory block

        const stackInfo: RTOSCommon.RTOSStackInfo = {
            stackStart: 0,
            stackTop: 0
        };

        if (tskStack) {
            stackInfo.stackTop = parseInt(tskStack);
        }

        if (stack) {
            stackInfo.stackStart = parseInt(stack);
        }

        // Calculate stack usage if we have both values
        if (stackInfo.stackStart && stackInfo.stackTop) {
            const stackDelta = Math.abs(stackInfo.stackTop - stackInfo.stackStart);
            if (this.stackIncrements < 0) {
                // Stack grows downward (typical for ARM)
                stackInfo.stackUsed = stackDelta;
                // We don't have easy access to stack size in RTX v4 without additional info
            } else {
                // Stack grows upward
                stackInfo.stackFree = stackDelta;
            }
        }

        return stackInfo;
    }

    public lastValidHtmlContent: RTOSCommon.HtmlInfo = { html: '', css: '' };
    public getHTML(): RTOSCommon.HtmlInfo {
        const htmlContent: RTOSCommon.HtmlInfo = { html: '', css: '' };

        if (this.status === 'none') {
            htmlContent.html = '<p>RTX v4 not yet fully initialized. Will occur next time program pauses</p>\n';
            return htmlContent;
        } else if (this.stale) {
            const lastHtmlInfo = this.lastValidHtmlContent;
            let msg = '';
            if (this.foundThreads.length === 0) {
                msg = ' Could not read any tasks. Perhaps program is busy or RTX v4 is not running';
                lastHtmlInfo.html = '';
                lastHtmlInfo.css = '';
            }
            lastHtmlInfo.html = `<p>RTX v4 RTOS information may be outdated${msg}</p>\n` + lastHtmlInfo.html;
            return lastHtmlInfo;
        } else if (this.status === 'failed') {
            htmlContent.html = `<p>RTX v4 RTOS detection failed: ${this.failedWhy}</p>\n`;
            return htmlContent;
        }

        // Generate HTML table for threads
        const ret = this.getHTMLThreads(DisplayFieldNames, RTX4Items, this.finalThreads, this.timeInfo);
        ret.html = ret.html + (this.helpHtml || '');
        this.lastValidHtmlContent = ret;
        return ret;
    }
}