import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { useUpdateStore } from '../store/useUpdateStore';
import './About.css';

const services = [
  { icon: '🖥️', title: '电脑 DIY 组装', desc: '个性化配置，性能优化' },
  { icon: '📹', title: '监控安防', desc: '监控安装与维护' },
  { icon: '🌐', title: '网络部署', desc: '路由器/交换机部署调试' },
  { icon: '💻', title: '软件应用开发', desc: '定制开发，满足需求' },
  { icon: '🏢', title: '企业网络搭建', desc: '企业级网络规划与实施' },
  { icon: '📱', title: '电子产品销售', desc: '电脑配件及数码产品' },
  { icon: '🏠', title: '智能家居', desc: '智能安防/家居系统方案' },
];

const features = [
  { icon: '🎨', title: '批量图像生成', desc: '支持 GPT Image 2 等模型，一键批量生成高质量图像' },
  { icon: '✏️', title: '图生图编辑', desc: '上传参考图，AI 智能改写与风格迁移' },
  { icon: '💬', title: '智能对话', desc: '多模型对话支持，GPT-4o / Claude 等主流模型' },
  { icon: '📦', title: '多模型支持', desc: '图像与对话模型自由切换，按需选择' },
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
        <h1 className="about-hero-title">关于我们</h1>
        <p className="about-hero-sub">晨阳电脑 · CyImagePro</p>
      </div>

      {/* 主体：左右两栏 */}
      <div className="about-main-row">
        {/* 左侧：关于晨阳电脑 */}
        <div className="about-card about-left-card">
          <h2 className="card-title">关于晨阳电脑</h2>
          <p className="card-desc">
            晨阳电脑成立于2004年，至今已有20年专业服务经验。我们专注于 AI 图像处理与智能对话领域，致力于为用户提供高效、便捷的 AI 创作工具。
          </p>
          <p className="card-desc">
            由一名拥有8年代码开发经验的工程师经营，我们始终坚持"专业、诚信、用心"的服务理念，为个人、家庭和企业客户提供高效、可靠的技术支持与解决方案。
          </p>
          <div className="info-list">
            <div className="info-item">
              <span className="info-label">店铺名称</span>
              <span className="info-value">晨阳电脑</span>
            </div>
            <div className="info-item">
              <span className="info-label">经营者</span>
              <span className="info-value">资深代码工程师（8年开发经验）</span>
            </div>
            <div className="info-item">
              <span className="info-label">成立时间</span>
              <span className="info-value">2004年（20年老店）</span>
            </div>
            <div className="info-item">
              <span className="info-label">联系电话</span>
              <span className="info-value">18106683831（微信同号）</span>
            </div>
            <div className="info-item">
              <span className="info-label">地址</span>
              <span className="info-value">浙江省宁波市慈溪市匡堰镇高家村晨阳电脑</span>
            </div>
          </div>
        </div>

        {/* 右侧：主营业务 */}
        <div className="about-card about-right-card">
          <h2 className="card-title">我们的主营业务</h2>
          <div className="biz-grid">
            {services.map((s, i) => (
              <div className="biz-card" key={i}>
                <span className="biz-icon">{s.icon}</span>
                <div>
                  <div className="biz-title">{s.title}</div>
                  <div className="biz-desc">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 产品特性 + 联系我们 */}
      <div className="about-main-row">
        {/* 产品特性 */}
        <div className="about-card about-features-card">
          <h2 className="card-title">产品特性</h2>
          <div className="features-grid">
            {features.map((f, i) => (
              <div className="feature-card" key={i}>
                <span className="feature-icon">{f.icon}</span>
                <div>
                  <div className="feature-title">{f.title}</div>
                  <div className="feature-desc">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 联系我们 */}
        <div className="about-card about-contact-card">
          <h2 className="card-title">联系我们</h2>
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
        <p>CyImagePro v{appVersion} · Powered by GPT Image 2</p>
        <button className="about-changelog-btn" onClick={handleOpenChangelog}>
          {status.checking ? '加载中...' : '查看更新日志'}
        </button>
      </div>
    </div>
  );
}
