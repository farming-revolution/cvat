// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { InfoCircleOutlined } from '@ant-design/icons';
import Modal from 'antd/lib/modal';
import Alert from 'antd/lib/alert';
import Button from 'antd/lib/button';
import CVATTooltip from 'components/common/cvat-tooltip';
import { CombinedState } from 'reducers';
import { getCVATStore } from 'cvat-store';
import { estimateHeight, Estimate, TrackSnapshot } from 'utils/height-diagnostic/estimate';
import { jobMetadata, refreshMetadata } from 'utils/height-diagnostic/metadata';

interface Props {
    snapshot(): Promise<TrackSnapshot>;
    supported: boolean;
}
interface Result {
    estimate: Estimate;
    states: CombinedState['annotation']['annotations']['states'];
}

function DiagnosticDialog({ result, recalculate, close }: {
    result: Result; recalculate(): void; close(): void;
}): JSX.Element {
    const states = useSelector((state: CombinedState) => state.annotation.annotations.states);
    const stale = states !== result.states;
    const { estimate } = result;
    let content = <Alert type='info' message={estimate.reason} />;
    if (stale) {
        content = <Alert type='warning' message='Annotations changed. Recalculate this estimate.' />;
    } else if (!estimate.reason) {
        content = (
            <>
                <p><strong>{`Estimated vertical camera height: ${(estimate.height! * 100).toFixed(0)} cm`}</strong></p>
                <p>
                    {`${estimate.count} keyframes; frames ${estimate.first}–${estimate.last}; `}
                    {`RMS reprojection error ${estimate.rms!.toFixed(1)} px.`}
                </p>
                {estimate.warnings.map((warning) => <Alert key={warning} type='warning' message={warning} />)}
            </>
        );
    }
    return (
        <Modal
            open
            title='Track height estimate'
            onCancel={close}
            footer={[<Button key='recalculate' onClick={recalculate}>Recalculate</Button>,
                <Button key='close' onClick={close}>Close</Button>]}
        >
            {content}
            <p>
                This is an estimate from this track, not an independent camera calibration.
                Correct the track first: an unchanged generated track can reproduce the original assumption.
            </p>
            <p>Unsaved corrections are included. No annotations or camera settings are changed.</p>
        </Modal>
    );
}

function HeightDiagnosticButton({ snapshot, supported }: Props): JSX.Element {
    const jobID = useSelector((state: CombinedState) => state.annotation.job.instance.id);
    const entry = jobMetadata(jobID);
    const [, update] = useState(0);
    const [result, setResult] = useState<Result | null>(null);
    useEffect(() => {
        const listener = (): void => update((n) => n + 1);
        entry.listeners.add(listener);
        return () => { entry.listeners.delete(listener); };
    }, [entry]);
    const calculate = async (): Promise<void> => {
        try {
            await refreshMetadata(entry, true);
            const { states } = getCVATStore().getState().annotation.annotations;
            const track = await snapshot();
            const estimate = entry.value ? estimateHeight(track, entry.value) :
                { reason: entry.reason, count: 0, warnings: [] };
            setResult({ estimate, states });
        } catch (_) {
            setResult({
                estimate: { reason: 'This track could not be inspected. Close and try again.', count: 0, warnings: [] },
                states: getCVATStore().getState().annotation.annotations.states,
            });
        }
    };
    const reason = supported ? entry.reason : 'Only tracks containing one stem point per keyframe are supported.';
    return (
        <>
            <CVATTooltip title={reason || 'Estimate vertical camera height from this track'}>
                <InfoCircleOutlined
                    role='button'
                    aria-label='Estimate track height'
                    aria-disabled={Boolean(reason)}
                    tabIndex={reason ? -1 : 0}
                    className='cvat-object-item-button-height-diagnostic'
                    style={reason ? { opacity: 0.35, cursor: 'not-allowed' } : {}}
                    onClick={reason ? undefined : calculate}
                    onKeyDown={reason ? undefined : (event) => {
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); calculate(); }
                    }}
                />
            </CVATTooltip>
            {result && <DiagnosticDialog result={result} recalculate={calculate} close={() => setResult(null)} />}
        </>
    );
}
export default React.memo(HeightDiagnosticButton);
