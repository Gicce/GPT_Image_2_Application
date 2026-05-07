import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
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

export default function About() {
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    getVersion().then(v => setAppVersion(v));
  }, []);

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
            晨阳电脑成立于2004年，至今已有20年专业服务经验。
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

      {/* API Token 模块 + 二维码 */}
      <div className="about-main-row">
        <div className="about-card about-token-card">
          <h2 className="card-title light">如何获取 API Token</h2>
          <div className="steps-flow">
            <div className="step-box">
              <div className="step-num">Step 1</div>
              <div className="step-heading">添加微信</div>
              <div className="step-detail">添加上方微信号</div>
              <div className="step-highlight">18106683831</div>
            </div>
            <div className="flow-arrow">→</div>
            <div className="step-box">
              <div className="step-num">Step 2</div>
              <div className="step-heading">免费试用</div>
              <div className="step-detail">添加后可免费试用</div>
              <div className="step-highlight">1美元额度</div>
            </div>
            <div className="flow-arrow">→</div>
            <div className="step-box">
              <div className="step-num">Step 3</div>
              <div className="step-heading">获取 Token</div>
              <div className="step-detail">联系微信客服获取</div>
              <div className="step-highlight">您的专属 API Token</div>
            </div>
          </div>
          <div className="token-footer-row">
            <div className="token-note">
              <strong>如需购买更多 Token</strong><br />
              可通过微信联系购买，支持按需定制套餐。
            </div>
            <div className="token-note">
              <strong>安全可靠</strong><br />
              您的 Token 仅用于 API 调用，我们严格保护您的数据安全。
            </div>
          </div>
          <p className="token-tip">有任何问题或技术支持，欢迎随时联系微信客服！</p>
        </div>

        {/* 二维码卡片 */}
        <div className="about-card about-qr-card">
          <h2 className="card-title">微信联系（扫一扫添加）</h2>
          <div className="qr-wrapper">
            <img src="/wechat-qr.jpg" alt="微信二维码" className="qr-img" />
          </div>
          <p className="qr-info">微信号：18106683831</p>
          <p className="qr-sub">添加后可免费试用 1 美元</p>
        </div>
      </div>

      {/* 底部页脚 */}
      <div className="about-page-footer">
        <p>CyImagePro v{appVersion} · Powered by GPT Image 2</p>
      </div>
    </div>
  );
}
