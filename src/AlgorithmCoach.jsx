import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Circle, Sparkles, AlertTriangle, Info } from 'lucide-react';

const guidance = {
  YouTube: {
    title: 'YouTube Shorts',
    signals: ['Make the topic clear in the first line and spoken opening.', 'Use a searchable title and a concise description.', 'Build a clear beginning, payoff and satisfying ending.', 'Use original footage or material you have rights to.'],
    metric: 'Audience retention, satisfaction and viewer choice',
    note: 'Shorts discovery is personalized; no hashtag or posting-time trick guarantees reach.'
  },
  TikTok: {
    title: 'TikTok',
    signals: ['Earn attention in the opening seconds; remove slow introductions.', 'Use specific keywords that describe what viewers see and hear.', 'Choose a small set of relevant hashtags, not generic tag stuffing.', 'Use suitable sounds and invite genuine conversation or sharing.'],
    metric: 'Watch time, completion, shares, comments and relevance',
    note: 'TikTok says user interactions and content information help shape recommendations.'
  },
  Instagram: {
    title: 'Instagram Reels',
    signals: ['Publish original, high-quality vertical video.', 'Make the Reel understandable without sound using readable captions.', 'Create something people may send to a friend or save.', 'Avoid visible third-party watermarks and low-value reposts.'],
    metric: 'Watch time, shares/sends, saves and recommendation eligibility',
    note: 'Check Account Status / recommendation eligibility in Instagram for account-specific restrictions.'
  },
  Facebook: {
    title: 'Facebook Reels',
    signals: ['Prioritize original footage or add substantial creative analysis and context.', 'Avoid duplicate uploads and superficial edits of someone else’s content.', 'Use a clear description that accurately represents the video.', 'Create a reason to watch, share or discuss the content.'],
    metric: 'Meaningful viewing, engagement, originality and viewer feedback',
    note: 'Meta says original content is prioritized while duplicative or low-value edits may be deprioritized.'
  }
};

function inspectVideo(file) {
  return new Promise(resolve => {
    if (!file || !file.type.startsWith('video/')) return resolve(null);
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      resolve({ width: video.videoWidth, height: video.videoHeight, duration: video.duration, url });
    };
    video.onerror = () => resolve({ width: 0, height: 0, duration: 0, url });
    video.src = url;
  });
}

export default function AlgorithmCoach({ platforms = [], caption = '', file = null }) {
  const [media, setMedia] = useState(null);
  useEffect(() => {
    let active = true;
    let current;
    inspectVideo(file).then(info => {
      if (!active) { if (info?.url) URL.revokeObjectURL(info.url); return; }
      current = info;
      setMedia(info);
    });
    return () => { active = false; if (current?.url) URL.revokeObjectURL(current.url); };
  }, [file]);

  const textChecks = useMemo(() => {
    const words = caption.trim().split(/\\s+/).filter(Boolean);
    const hashtags = caption.match(/#[\\p{L}\\p{N}_]+/gu) || [];
    const hasQuestionOrPrompt = /\\?|\\b(comment|share|save|follow|tell me|which|what do you think)\\b/i.test(caption);
    const hasTopic = words.length >= 8;
    return { words: words.length, hashtags: hashtags.length, hasPrompt: hasQuestionOrPrompt, hasTopic };
  }, [caption]);

  const ratio = media?.width && media?.height ? media.width / media.height : null;
  const vertical = ratio !== null && ratio < 0.8;
  const formatStatus = !media ? 'Add a video to inspect its format.' : vertical && media.height >= 1280 ? 'Vertical format detected.' : vertical ? 'Vertical, but consider exporting at 720 × 1280 or higher.' : 'This is not a 9:16 vertical video; consider a dedicated vertical cut for Reels and Shorts.';
  const chosen = platforms.filter(name => guidance[name]);

  return <section className="algorithm-coach">
    <div className="algorithm-head">
      <div className="algorithm-icon"><Sparkles size={17}/></div>
      <div><b>Reach readiness</b><p>Practical checks based on each platform’s published creator guidance.</p></div>
      <span className="algorithm-live">LIVE CHECK</span>
    </div>
    <div className="algorithm-checks">
      <div className="algorithm-check"><span>{textChecks.hasTopic ? <CheckCircle2/> : <Circle/>}</span><div><b>Clear topic and context</b><small>{textChecks.hasTopic ? 'Caption gives viewers useful context.' : 'Add a specific sentence explaining what viewers will get.'}</small></div></div>
      <div className="algorithm-check"><span>{textChecks.hasPrompt ? <CheckCircle2/> : <Circle/>}</span><div><b>Conversation or value prompt</b><small>{textChecks.hasPrompt ? 'A prompt is present; keep it natural.' : 'Consider a genuine question, takeaway or reason to save/share.'}</small></div></div>
      <div className="algorithm-check"><span>{textChecks.hashtags > 0 && textChecks.hashtags <= 5 ? <CheckCircle2/> : <Info/>}</span><div><b>Relevant hashtags</b><small>{textChecks.hashtags === 0 ? 'Add a few specific tags only if they help describe the topic.' : textChecks.hashtags > 5 ? 'You have many tags; remove broad or unrelated ones.' : 'Keep these tags closely related to the video.'}</small></div></div>
      <div className="algorithm-check"><span>{media && vertical && media.height >= 1280 ? <CheckCircle2/> : <AlertTriangle/>}</span><div><b>Video format</b><small>{media ? `${media.width} × ${media.height} · ${Math.round(media.duration || 0)} sec. ${formatStatus}` : formatStatus}</small></div></div>
    </div>
    {chosen.length ? <div className="platform-guidance">{chosen.map(name => {
      const item = guidance[name];
      return <div className="platform-guidance-card" key={name}><div className="platform-guidance-title"><b>{item.title}</b><span>{item.metric}</span></div><ul>{item.signals.map(signal => <li key={signal}>{signal}</li>)}</ul><p><Info size={13}/>{item.note}</p></div>;
    })}</div> : <div className="algorithm-empty">Select one or more connected platforms to see tailored publishing guidance.</div>}
    <p className="algorithm-footnote">These are quality recommendations, not secret ranking rules or guaranteed reach scores. Platform policies, eligibility and limits can change.</p>
  </section>;
}
