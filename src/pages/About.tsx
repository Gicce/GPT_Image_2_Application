import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { useUpdateStore } from '../store/useUpdateStore';
import { RELEASE_INFO } from '../config/release';
import './About.css';

const introParagraphs = [
  'CyImagePro 是一款面向 AI 图片创作与批量生产场景的桌面应用，由 CY 开发。',
  'CY 拥有多年软件开发与项目实践经验，希望通过 CyImagePro 将复杂的 AI 图片生成、提示词优化、批量方案规划、任务管理和素材管理流程整合为更加直观、高效的创作工具。',
  '项目目前围绕 GPT Image 2 构建图片生成能力，并整合 AI 提示词优化、智能批量方案规划、图片编辑、任务队列、历史记录、图片库以及与 CY Video Studio 的素材联动。',
  'CyImagePro 的目标是让用户从「描述需求」开始，完成方案规划、图片生成、结果管理以及继续进入视频制作的完整工作流。',
];

const features = [
  { icon: '🎨', title: 'AI 图片生成', desc: '支持 GPT Image 2 文生图与图片编辑。' },
  { icon: '🧩', title: 'AI 智能批量规划', desc: '一个自然语言需求即可规划多个差异化生成方案。' },
  { icon: '✨', title: 'AI 提示词优化', desc: '自动生成中文正向提示词与负面提示词。' },
  { icon: '📋', title: '任务管理', desc: '统一管理生成任务、执行状态和历史结果。' },
  { icon: '🖼️', title: '图片素材库', desc: '集中预览、管理、编辑和复用所有生成图片。' },
  { icon: '🎬', title: 'Image → Video', desc: '生成图片可直接同步至 CY Video Studio，用于后续图生视频和视频创作。' },
];

export default function About() {
  const [appVersion, setAppVersion] = useState('');
  const { openChangelog, checkUpdate, status } = useUpdateStore();

  useEffect(() => {
    getVersion().then(v => setAppVersion(v));
  }, []);

  const handleOpenChangelog = async () => {
    if (status.recentReleases.length === 0) {
      await checkUpdate();
    }
    openChangelog();
  };

  return (
    <div className="about-page">
      {/* 顶部标题区 */}
      <div className="about-hero">
        <h1 className="about-hero-title">关于 CyImagePro</h1>
        <p className="about-hero-sub">AI 图片生产与智能创作工具</p>
      </div>

      {/* ① 项目介绍 */}
      <div className="about-card about-section-card">
        <h2 className="card-title">项目介绍</h2>
        {introParagraphs.map((text, i) => (
          <p className="card-desc" key={i}>{text}</p>
        ))}
        <div className="info-list">
          <div className="info-item">
            <span className="info-label">项目名称</span>
            <span className="info-value">CyImagePro</span>
          </div>
          <div className="info-item">
            <span className="info-label">作者</span>
            <span className="info-value">CY</span>
          </div>
          <div className="info-item">
            <span className="info-label">开发经验</span>
            <span className="info-value">多年软件开发与项目实践经验</span>
          </div>
          <div className="info-item">
            <span className="info-label">定位</span>
            <span className="info-value">AI 图片生产与智能创作工具</span>
          </div>
          <div className="info-item">
            <span className="info-label">当前版本</span>
            <span className="info-value">{appVersion ? `V${appVersion}` : '读取中…'}</span>
          </div>
          <div className="info-item">
            <span className="info-label">发布阶段</span>
            <span className="info-value">{RELEASE_INFO.label}</span>
          </div>
        </div>
      </div>

      {/* ② 产品特性 */}
      <div className="about-card about-section-card">
        <h2 className="card-title">产品特性</h2>
        <div className="features-grid">
          {features.map(f => (
            <div className="feature-card" key={f.title}>
              <span className="feature-icon">{f.icon}</span>
              <div>
                <div className="feature-title">{f.title}</div>
                <div className="feature-desc">{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ③ 联系我们 */}
      <div className="about-card about-section-card about-contact-card">
        <h2 className="card-title">联系我们</h2>
        <div className="contact-body">
          <div className="contact-sections">
            <div className="contact-section">
              <div className="contact-label">售前咨询</div>
              <div className="contact-wechat">微信：18106683831</div>
              <div className="contact-desc">产品咨询、功能介绍、方案定制</div>
            </div>
            <div className="contact-divider" />
            <div className="contact-section">
              <div className="contact-label">售后咨询</div>
              <div className="contact-wechat">微信：18106683831</div>
              <div className="contact-desc">技术支持、问题反馈、使用指导</div>
            </div>
          </div>
          <div className="qr-wrapper">
            <img src="/wechat-qr.jpg" alt="微信二维码" className="qr-img" />
          </div>
          <p className="qr-info">扫码添加微信</p>
        </div>
      </div>

      {/* 底部页脚 */}
      <div className="about-page-footer">
        <p>CyImagePro {appVersion ? `V${appVersion}` : ''} · Powered by GPT Image 2</p>
        <button className="about-changelog-btn" onClick={handleOpenChangelog}>
          {status.phase === 'checking' ? '加载中...' : '查看更新日志'}
        </button>
      </div>
    </div>
  );
}
