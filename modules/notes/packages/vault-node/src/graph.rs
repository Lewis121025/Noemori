//! 关系图谱的 Node-API 适配。

use crate::runtime::{with_vault, NativeRuntime};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// 图谱节点：笔记或死链目标。
#[napi(object)]
pub struct JsGraphNode {
    /// 笔记的库内相对路径；死链为去掉锚点后的目标原文。
    pub path: String,
    /// 展示标题。
    pub title: String,
    /// 标签，升序。
    pub tags: Vec<String>,
    /// 是否为尚未创建的死链目标。
    pub dead: bool,
}

/// 图谱中的有向边。
#[napi(object)]
pub struct JsGraphEdge {
    /// 源笔记路径。
    pub from: String,
    /// 目标节点的 `path`。
    pub to: String,
    /// 这对起止之间的链接条数。
    pub count: u32,
}

/// 全库图谱。
#[napi(object)]
pub struct JsGraph {
    /// 节点，按路径升序。
    pub nodes: Vec<JsGraphNode>,
    /// 边，按起止升序。
    pub edges: Vec<JsGraphEdge>,
}

#[napi]
impl NativeRuntime {
    /// 全库关系图谱；`include_dead` 为真时死链目标作为虚节点出现。
    ///
    /// # Errors
    ///
    /// 未打开库或索引查询失败。
    #[napi(ts_return_type = "Promise<JsGraph>")]
    pub fn index_graph(&self, env: Env, include_dead: bool) -> Result<Object> {
        self.read(env, move |vault| {
            let graph = with_vault(vault, |vault| vault.graph(include_dead))?;
            Ok(JsGraph {
                nodes: graph
                    .nodes
                    .into_iter()
                    .map(|node| JsGraphNode {
                        path: node.path,
                        title: node.title,
                        tags: node.tags,
                        dead: node.dead,
                    })
                    .collect::<Vec<_>>(),
                edges: graph
                    .edges
                    .into_iter()
                    .map(|edge| JsGraphEdge {
                        from: edge.from,
                        to: edge.to,
                        count: edge.count,
                    })
                    .collect::<Vec<_>>(),
            })
        })
    }
}
