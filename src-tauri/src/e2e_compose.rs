//! V4.2.11 鸭梨山大 E2E：最终页组合器（Rust 等价实现，#[ignore] 测试形态）。
//!
//! 为什么在 Rust：vitest 运行在 Node（jsdom 无 canvas 2D 实现），
//! `renderComicSheets` 的 DOM canvas 路径无法在测试环境出图；
//! E2E 的「组合最终页」由本模块用 image/imageproc 完成——
//! **几何与文字层语义与 `src/features/comic/comicExport.ts` 同源**：
//!  - 画布/槽位矩形由前端 `computePageLayouts`（纯函数）算好经 JSON 传入，
//!    Rust 不再自带第二套排版（§89 布局单一事实源）；
//!  - 底图 cover-crop（scale = max(槽/图) 居中裁切，同 drawCover）；
//!  - 文字层：气泡框 + 自动换行（0.72 槽宽，至多 6 行）+ 对齐 + 台词类型配色，
//!    与 `drawDialogue` 的画布行为一致（字体 = 系统黑体）。
//!
//! 输入：环境变量 `V4211_COMPOSE_INPUT` 指向 JSON 文件（由 vitest 侧生成）。
//! 仅 `cargo test e2e_compose_final_page -- --ignored` 显式执行；不进任何发布产物。

#![cfg(test)]

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use serde::Deserialize;

#[derive(Deserialize)]
struct ComposeSlot {
    path: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Deserialize)]
struct ComposeText {
    /// 槽位归一化坐标 0..1（与 ComicDialogue.position 同源）。
    x: f32,
    y: f32,
    text: String,
    font_size: f32,
    #[serde(default)]
    align: String,
    /// 台词/标题类（画深色底 + 白字）；对白默认白底黑字。
    #[serde(default)]
    dark: bool,
    #[serde(default)]
    bubble: bool,
    /// 文字所属槽位下标（坐标按该槽矩形换算）。
    slot: usize,
}

#[derive(Deserialize)]
struct ComposeInput {
    output: String,
    width: u32,
    height: u32,
    #[serde(default = "default_background")]
    background: String,
    slots: Vec<ComposeSlot>,
    #[serde(default)]
    texts: Vec<ComposeText>,
}

fn default_background() -> String {
    "#ffffff".to_string()
}

fn parse_hex_color(value: &str) -> image::Rgba<u8> {
    let hex = value.trim_start_matches('#');
    if hex.len() == 6 {
        if let Ok(parsed) = u32::from_str_radix(hex, 16) {
            let r = ((parsed >> 16) & 0xff) as u8;
            let g = ((parsed >> 8) & 0xff) as u8;
            let b = (parsed & 0xff) as u8;
            return image::Rgba([r, g, b, 255]);
        }
    }
    image::Rgba([255, 255, 255, 255])
}

/// cover-crop：等比放大到完全覆盖槽位后居中裁切（同 drawCover 的 scale=max 语义）。
fn cover_crop(source: &image::DynamicImage, slot_w: u32, slot_h: u32) -> image::DynamicImage {
    let (src_w, src_h) = (source.width().max(1), source.height().max(1));
    let scale = (slot_w as f32 / src_w as f32).max(slot_h as f32 / src_h as f32);
    let resize_w = ((src_w as f32 * scale).ceil() as u32).max(slot_w);
    let resize_h = ((src_h as f32 * scale).ceil() as u32).max(slot_h);
    let resized = source.resize_exact(resize_w, resize_h, image::imageops::FilterType::Lanczos3);
    resized.crop_imm((resize_w - slot_w) / 2, (resize_h - slot_h) / 2, slot_w, slot_h)
}

fn text_width<F>(line: &str, font: &F, scale: PxScale) -> f32
where
    F: Font,
{
    let scaled = font.into_scaled(scale);
    line.chars().map(|c| scaled.h_advance(font.glyph_id(c)).abs()).sum()
}

/// 逐字累计宽度换行（同 wrapText 语义；至多 6 行）。
fn wrap_text<F>(text: &str, font: &F, scale: PxScale, max_width: f32) -> Vec<String>
where
    F: Font,
{
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        let candidate = format!("{current}{ch}");
        if text_width(&candidate, font, scale) > max_width && !current.is_empty() {
            lines.push(current.clone());
            current = ch.to_string();
        } else {
            current = candidate;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines.into_iter().take(6).collect()
}

fn blend_pixel(target: &mut image::RgbaImage, x: i64, y: i64, color: [u8; 4]) {
    if x < 0 || y < 0 || x >= target.width() as i64 || y >= target.height() as i64 {
        return;
    }
    let pixel = target.get_pixel_mut(x as u32, y as u32);
    let a = color[3] as u16;
    let inv = 255 - a;
    pixel[0] = ((color[0] as u16 * a + pixel[0] as u16 * inv) / 255) as u8;
    pixel[1] = ((color[1] as u16 * a + pixel[1] as u16 * inv) / 255) as u8;
    pixel[2] = ((color[2] as u16 * a + pixel[2] as u16 * inv) / 255) as u8;
    pixel[3] = 255;
}

#[test]
#[ignore = "V4.2.11 E2E 专用：需 V4211_COMPOSE_INPUT 指向组合输入（vitest 侧生成）"]
fn e2e_compose_final_page() {
    let input_path = std::env::var("V4211_COMPOSE_INPUT").expect("缺少 V4211_COMPOSE_INPUT");
    let raw = std::fs::read_to_string(&input_path).expect("读取组合输入失败");
    let input: ComposeInput = serde_json::from_str(&raw).expect("组合输入 JSON 无效");

    let mut canvas = image::RgbaImage::from_pixel(input.width, input.height, parse_hex_color(&input.background));

    // 1) 底图：cover-crop 逐槽铺入
    for slot in &input.slots {
        let source = image::open(&slot.path).unwrap_or_else(|err| panic!("打开底图失败 {}: {}", slot.path, err));
        let cell = cover_crop(&source, slot.width as u32, slot.height as u32);
        image::imageops::overlay(&mut canvas, &cell, slot.x as i64, slot.y as i64);
    }

    // 2) 文字层：气泡框 + 换行 + 对齐（同 drawDialogue 语义；字体 = 系统黑体）
    let font_bytes = std::fs::read("C:/Windows/Fonts/simhei.ttf").expect("缺少系统黑体字体");
    let font = FontRef::try_from_slice(&font_bytes).expect("字体解析失败");
    for text in &input.texts {
        let slot = input.slots.get(text.slot).expect("台词引用了不存在的槽位");
        let font_size = (text.font_size * 2.0).max(18.0);
        let scale = PxScale::from(font_size);
        let max_width = slot.width * 0.72;
        let lines = wrap_text(text.text.trim(), &font, scale, max_width);
        if lines.is_empty() {
            continue;
        }
        let line_height = font_size * 1.35;
        let content_width = lines
            .iter()
            .map(|line| text_width(line, &font, scale))
            .fold(0f32, f32::max)
            .min(max_width);
        let box_width = content_width + font_size;
        let box_height = lines.len() as f32 * line_height + font_size * 0.7;
        let center_x = slot.x + text.x * slot.width;
        let center_y = slot.y + text.y * slot.height;
        let box_x = center_x - box_width / 2.0;
        let box_y = center_y - box_height / 2.0;

        if text.bubble {
            let fill = if text.dark { [0u8, 0, 0, 158] } else { [255u8, 255, 255, 240] };
            let stroke = [17u8, 17, 17, 90];
            let bx = box_x as i64;
            let by = box_y as i64;
            let bw = box_width as i64;
            let bh = box_height as i64;
            for px in bx..(bx + bw) {
                for py in by..(by + bh) {
                    let on_stroke = px < bx + 2 || px >= bx + bw - 2 || py < by + 2 || py >= by + bh - 2;
                    blend_pixel(&mut canvas, px, py, if on_stroke { stroke } else { fill });
                }
            }
        }

        let color = if text.dark {
            image::Rgba([255, 255, 255, 255])
        } else {
            image::Rgba([17, 17, 17, 255])
        };
        for (index, line) in lines.iter().enumerate() {
            let line_w = text_width(line, &font, scale);
            let anchor_x = match text.align.as_str() {
                "left" => box_x + font_size * 0.4,
                "right" => box_x + box_width - font_size * 0.4 - line_w,
                _ => center_x - line_w / 2.0,
            };
            let baseline_y = box_y + font_size * 0.95 + index as f32 * line_height;
            imageproc::drawing::draw_text_mut(
                &mut canvas,
                color,
                anchor_x as i32,
                baseline_y as i32,
                scale,
                &font,
                line,
            );
        }
    }

    if let Some(parent) = std::path::Path::new(&input.output).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    canvas
        .save(&input.output)
        .unwrap_or_else(|err| panic!("写入最终页失败 {}: {}", input.output, err));
}
