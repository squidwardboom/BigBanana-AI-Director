import React, { useState, useRef, useEffect } from 'react';
import { Film } from 'lucide-react';
import { ProjectState } from '../../types';
import {
  downloadMasterVideo,
  downloadSourceAssets,
  MasterExportMode,
  MasterVideoQuality,
} from '../../services/exportService';
import { exportProjectData } from '../../services/storageService';
import { STYLES } from './constants';
import {
  calculateEstimatedDuration,
  calculateProgress,
  getCompletedShots,
  collectRenderLogs,
  hasDownloadableAssets
} from './utils';
import StatusPanel from './StatusPanel';
import TimelineVisualizer from './TimelineVisualizer';
import ActionButtons from './ActionButtons';
import SecondaryOptions from './SecondaryOptions';
import VideoPlayerModal from './VideoPlayerModal';
import RenderLogsModal from './RenderLogsModal';
import { useAlert } from '../GlobalAlert';
import ShuohaoEngineBar from '../ShuohaoEngineBar';
import {
  useBackupTransfer,
  EPISODE_BACKUP_TRANSFER_MESSAGES,
  episodeBackupFileName,
} from '../../hooks/useBackupTransfer';

interface Props {
  project: ProjectState;
}

const StageExport: React.FC<Props> = ({ project }) => {
  const { showAlert } = useAlert();
  const completedShots = getCompletedShots(project);
  const progress = calculateProgress(project);
  const estimatedDuration = calculateEstimatedDuration(project);

  // Download state
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadPhase, setDownloadPhase] = useState('');
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [exportMode, setExportMode] = useState<MasterExportMode>('master-video');
  const [exportQuality, setExportQuality] = useState<MasterVideoQuality>('balanced');

  // Source Assets Download state
  const [isDownloadingAssets, setIsDownloadingAssets] = useState(false);
  const [assetsPhase, setAssetsPhase] = useState('');
  const [assetsProgress, setAssetsProgress] = useState(0);

  // Render Logs Modal state
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  // Video Preview Player state
  const [showVideoPlayer, setShowVideoPlayer] = useState(false);
  const [currentShotIndex, setCurrentShotIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Auto-play when shot changes
  useEffect(() => {
    const video = videoRef.current;
    if (video && showVideoPlayer) {
      video.currentTime = 0;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => setIsPlaying(true))
          .catch(err => {
            console.warn('Auto-play failed:', err);
            setIsPlaying(false);
          });
      }
    }
  }, [currentShotIndex, showVideoPlayer]);

  // Video player handlers
  const handlePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      video.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const handlePrevShot = () => {
    if (currentShotIndex > 0) {
      setCurrentShotIndex(prev => prev - 1);
    }
  };

  const handleNextShot = () => {
    if (currentShotIndex < completedShots.length - 1) {
      setCurrentShotIndex(prev => prev + 1);
    }
  };

  const openVideoPlayer = () => {
    if (completedShots.length > 0) {
      setCurrentShotIndex(0);
      setShowVideoPlayer(true);
      setIsPlaying(true);
    }
  };

  const closeVideoPlayer = () => {
    setShowVideoPlayer(false);
    setIsPlaying(false);
    if (videoRef.current) {
      videoRef.current.pause();
    }
  };

  // Handle master video download
  const handleDownloadMaster = async () => {
    const canDownloadMaster = progress === 100;
    const canDownloadSegments = completedShots.length > 0;
    const canDownloadByMode = exportMode === 'segments-zip' ? canDownloadSegments : canDownloadMaster;
    if (isDownloading || !canDownloadByMode) return;
    
    setIsDownloading(true);
    setDownloadProgress(0);
    
    try {
      await downloadMasterVideo(project, (phase, prog) => {
        setDownloadPhase(phase);
        setDownloadProgress(prog);
      }, {
        mode: exportMode,
        quality: exportQuality,
      });
      
      setTimeout(() => {
        setIsDownloading(false);
        setDownloadPhase('');
        setDownloadProgress(0);
      }, 2000);
    } catch (error) {
      console.error('Download failed:', error);
      showAlert(`导出失败: ${error instanceof Error ? error.message : '未知错误'}`, { type: 'error' });
      setIsDownloading(false);
      setDownloadPhase('');
      setDownloadProgress(0);
    }
  };

  // Handle source assets download
  const handleDownloadAssets = async () => {
    if (isDownloadingAssets) return;
    
    if (!hasDownloadableAssets(project)) {
      showAlert('没有可下载的资源。请先生成角色、场景或镜头素材。', { type: 'warning' });
      return;
    }
    
    setIsDownloadingAssets(true);
    setAssetsProgress(0);
    
    try {
      await downloadSourceAssets(project, (phase, prog) => {
        setAssetsPhase(phase);
        setAssetsProgress(prog);
      });
      
      setTimeout(() => {
        setIsDownloadingAssets(false);
        setAssetsPhase('');
        setAssetsProgress(0);
      }, 2000);
    } catch (error) {
      console.error('Assets download failed:', error);
      showAlert(`下载源资源失败: ${error instanceof Error ? error.message : '未知错误'}`, { type: 'error' });
      setIsDownloadingAssets(false);
      setAssetsPhase('');
      setAssetsProgress(0);
    }
  };

  const {
    importInputRef,
    isDataExporting,
    isDataImporting,
    handleExportData,
    handleImportData,
    handleImportFileChange,
  } = useBackupTransfer({
    exporter: () => exportProjectData(project),
    exportFileName: (timestamp) => episodeBackupFileName(project.id, timestamp),
    showAlert,
    messages: EPISODE_BACKUP_TRANSFER_MESSAGES,
  });

  return (
    <div className={STYLES.container}>
      <ShuohaoEngineBar projectId={project.id} projectTitle={project.title} tab="export" />
      {/* Header */}
      <div className={STYLES.header.container}>
        <div className="flex items-center gap-4">
          <h2 className={STYLES.header.title}>
            <Film className="w-5 h-5 text-[var(--accent)]" />
            成片与导出 <span className={STYLES.header.subtitle}>渲染与导出</span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className={STYLES.header.status}>
            状态：{progress === 100 ? '已就绪' : '进行中'}
          </span>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-8 md:p-12">
        <div className="max-w-6xl mx-auto space-y-8">
          
          {/* Main Status Panel */}
          <div>
            <StatusPanel 
              project={project}
              progress={progress}
              estimatedDuration={estimatedDuration}
            />
            
            {/* Timeline Visualizer */}
            <TimelineVisualizer shots={project.shots} />
            
            {/* Action Buttons */}
            <ActionButtons
              completedShotsCount={completedShots.length}
              totalShots={project.shots.length}
              progress={progress}
              downloadState={{
                isDownloading,
                phase: downloadPhase,
                progress: downloadProgress
              }}
              exportMode={exportMode}
              exportQuality={exportQuality}
              onExportModeChange={setExportMode}
              onExportQualityChange={setExportQuality}
              onPreview={openVideoPlayer}
              onDownloadMaster={handleDownloadMaster}
            />
          </div>

          {/* Secondary Options */}
          <SecondaryOptions
            assetsDownloadState={{
              isDownloading: isDownloadingAssets,
              phase: assetsPhase,
              progress: assetsProgress
            }}
            onDownloadAssets={handleDownloadAssets}
            onShowLogs={() => setShowLogsModal(true)}
            onExportData={handleExportData}
            onImportData={handleImportData}
            isDataExporting={isDataExporting}
            isDataImporting={isDataImporting}
          />

        </div>
      </div>

      {/* Video Preview Player Modal */}
      {showVideoPlayer && completedShots.length > 0 && (
        <VideoPlayerModal
          completedShots={completedShots}
          currentShotIndex={currentShotIndex}
          isPlaying={isPlaying}
          project={project}
          onClose={closeVideoPlayer}
          onPlayPause={handlePlayPause}
          onPrevShot={handlePrevShot}
          onNextShot={handleNextShot}
          onShotChange={setCurrentShotIndex}
          videoRef={videoRef}
        />
      )}

      {/* Render Logs Modal */}
      {showLogsModal && (
        <RenderLogsModal
          logs={collectRenderLogs(project)}
          expandedLogId={expandedLogId}
          onClose={() => setShowLogsModal(false)}
          onToggleExpand={(logId) => setExpandedLogId(expandedLogId === logId ? null : logId)}
        />
      )}

      <input
        ref={importInputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={handleImportFileChange}
      />
    </div>
  );
};

export default StageExport;

