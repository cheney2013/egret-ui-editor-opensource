import { IExmlModel } from './models';
import { INode, isInstanceof, IContainer, IClass } from './treeNodes';
import { coordinateTransfrom } from '../utils/transfroms';
import { EUI } from '../project/parsers/core/commons';
import { sortOnDepth, cleanRelatvieProps } from './exmlModel';
import { isArray } from 'egret/base/common/types';
import { endWith } from '../utils/strings';
import { copypAllPropertyToClipboard, pastePosFromClipboard, pasteSizeFromClipboard, pasteRestrictFromClipboard } from './nodeClipboard';
import { IDisposable } from 'egret/base/common/lifecycle';

import * as sax from '../sax/sax';
import * as xmlTagUtil from '../sax/xml-tagUtils';
import * as fs from 'fs';

/**
 * ExmlModel工具
 */
export class ExmlModelHelper implements IDisposable {
	/**
	 *
	 */
	constructor() {

	}
	protected _model: IExmlModel;
	/**
	 * 当前视图的exml数据层
	 */
	public getModel(): IExmlModel {
		return this._model;
	}
	/**
	 * 当前视图的exml数据层
	 */
	public setModel(value: IExmlModel): void {
		if (this._model == value) {
			return;
		}
		this._model = value;
	}

	/**
	 * 组合选中的节点，放进一个Group。
	 * 支持单个或多个节点的组合操作。
	 * 保留子节点的约束属性，并根据 Group 位置重新计算约束值。
	 */
	public groupNodes(): void {
		const nodeList: INode[] = this._model.getSelectedNodes();
		const length: number = nodeList.length;
		// 允许单个节点也能创建 Group
		if (length < 1 || nodeList.indexOf(this.rootNode) !== -1) {
			return;
		}
		let topNode: INode = nodeList[0];
		let node: INode;
		for (var i = 0; i < length; i++) {
			node = nodeList[i];
			node.setSelected(false);
			if (isInstanceof(node.getParent(), 'eui.ISingleChild')) {
				nodeList[i] = node.getParent();
				node = node.getParent();
			}
			if (node.getNestLevel() < topNode.getNestLevel()) {
				topNode = node;
			}
		}
		const parentNode: IContainer = topNode.getParent();
		let groupIndex: number = topNode.getParent().getNodeIndex(topNode);
		for (i = 1; i < length; i++) {
			node = nodeList[i];
			const index: number = parentNode.getNodeIndex(node);
			if (index > groupIndex) {
				groupIndex = index;
			}
		}

		const groupNode: IContainer = this._model.createIContainer('Group', EUI);
		topNode.getParent().addNodeAt(groupNode, groupIndex + 1);

		node = nodeList[0];

		// 保存每个节点的约束属性
		const constraintKeys = ['left', 'right', 'top', 'bottom', 'horizontalCenter', 'verticalCenter'];
		const nodeConstraints: { [key: string]: any }[] = [];
		const nodePercentSizes: { width?: string; height?: string }[] = [];
		for (i = 0; i < length; i++) {
			node = nodeList[i];
			const constraints: { [key: string]: any } = {};
			for (const key of constraintKeys) {
				const prop = node.getProperty(key);
				if (prop) {
					const value = prop.getInstance();
					if (value !== null && value !== undefined) {
						constraints[key] = value;
					}
				}
			}
			nodeConstraints.push(constraints);
			
			// 保存百分比宽高
			const percentSize: { width?: string; height?: string } = {};
			const widthProp = node.getProperty('width');
			if (widthProp && typeof widthProp.getInstance() === 'string') {
				percentSize.width = widthProp.getInstance();
			}
			const heightProp = node.getProperty('height');
			if (heightProp && typeof heightProp.getInstance() === 'string') {
				percentSize.height = heightProp.getInstance();
			}
			nodePercentSizes.push(percentSize);
		}

	    const minPos = coordinateTransfrom({ x: 0, y: 0 }, nodeList[0], groupNode.getParent());
	   // 记录每个节点的锚点和位置
	   let anchorXs: number[] = [];
	   let anchorYs: number[] = [];
	   let maxX = minPos.x;
	   let maxY = minPos.y;
	   for (i = 0; i < length; i++) {
		   node = nodeList[i];
		   var pos = coordinateTransfrom({ x: 0, y: 0 }, node, groupNode.getParent());
		   let anchorX = node.getProperty('anchorOffsetX') ? node.getProperty('anchorOffsetX').getInstance() : 0;
		   let anchorY = node.getProperty('anchorOffsetY') ? node.getProperty('anchorOffsetY').getInstance() : 0;
		   anchorXs.push(anchorX);
		   anchorYs.push(anchorY);
		   
		   // 获取节点的实际宽高
		   const nodeWidth = node.getInstance() ? node.getInstance().width : 0;
		   const nodeHeight = node.getInstance() ? node.getInstance().height : 0;
		   
		   if (pos) {
			   if (minPos.x > pos.x) {
				   minPos.x = pos.x;
			   }
			   if (minPos.y > pos.y) {
				   minPos.y = pos.y;
			   }
			   if (maxX < pos.x + nodeWidth) {
				   maxX = pos.x + nodeWidth;
			   }
			   if (maxY < pos.y + nodeHeight) {
				   maxY = pos.y + nodeHeight;
			   }
		   }
	   }
	   
	   // 计算 Group 的尺寸
	   const groupWidth = maxX - minPos.x;
	   const groupHeight = maxY - minPos.y;
	   
	   // 获取父容器尺寸（用于计算 right/bottom）
	   const parentWidth = parentNode.getInstance() ? parentNode.getInstance().width : 0;
	   const parentHeight = parentNode.getInstance() ? parentNode.getInstance().height : 0;
	   
	   // Group 使用 x/y 定位
	   const groupX = Math.round(minPos.x * 100) / 100;
	   const groupY = Math.round(minPos.y * 100) / 100;
	   groupNode.setNumber('x', groupX);
	   groupNode.setNumber('y', groupY);
	   groupNode.setNumber('width', groupWidth);
	   groupNode.setNumber('height', groupHeight);

	   nodeList.sort(sortOnDepth);
	   for (i = 0; i < length; i++) {
		   node = nodeList[i];
		   const constraints = nodeConstraints[i];
		   const percentSize = nodePercentSizes[i];
		   // 计算锚点偏移后的位置
		   let anchorX = anchorXs[i];
		   let anchorY = anchorYs[i];
		   pos = coordinateTransfrom({ x: 0, y: 0 }, node, groupNode);
		   
		   // 获取节点宽高
		   const nodeWidth = node.getInstance() ? node.getInstance().width : 0;
		   const nodeHeight = node.getInstance() ? node.getInstance().height : 0;
		   
		   // 先清除约束属性（为了重新设置）
		   for (const key of constraintKeys) {
			   node.setProperty(key, null);
		   }
		   
		   groupNode.addNode(node);
		   
		   // 计算子节点相对于 Group 的新坐标
		   const newX = Math.round((pos.x + anchorX) * 100) / 100;
		   const newY = Math.round((pos.y + anchorY) * 100) / 100;
		   
		   // 根据原约束类型，重新计算相对于 Group 的约束值
		   const hasHorizontalConstraint = constraints['left'] !== undefined || 
			   constraints['right'] !== undefined || 
			   constraints['horizontalCenter'] !== undefined;
		   const hasVerticalConstraint = constraints['top'] !== undefined || 
			   constraints['bottom'] !== undefined || 
			   constraints['verticalCenter'] !== undefined;
		   
		   if (hasHorizontalConstraint) {
			   // 重新计算水平约束
			   if (constraints['left'] !== undefined) {
				   // left 相对于 Group 左边的距离
				   node.setNumber('left', newX);
			   }
			   if (constraints['right'] !== undefined) {
				   // right 相对于 Group 右边的距离
				   const newRight = groupWidth - newX - nodeWidth;
				   node.setNumber('right', Math.round(newRight * 100) / 100);
			   }
			   if (constraints['horizontalCenter'] !== undefined) {
				   // horizontalCenter 相对于 Group 中心的偏移
				   const nodeCenter = newX + nodeWidth / 2;
				   const groupCenter = groupWidth / 2;
				   const newHC = Math.round((nodeCenter - groupCenter) * 100) / 100;
				   node.setNumber('horizontalCenter', newHC);
			   }
		   } else {
			   // 没有水平约束，使用 x
			   node.setNumber('x', newX);
		   }
		   
		   if (hasVerticalConstraint) {
			   // 重新计算垂直约束
			   if (constraints['top'] !== undefined) {
				   // top 相对于 Group 顶部的距离
				   node.setNumber('top', newY);
			   }
			   if (constraints['bottom'] !== undefined) {
				   // bottom 相对于 Group 底部的距离
				   const newBottom = groupHeight - newY - nodeHeight;
				   node.setNumber('bottom', Math.round(newBottom * 100) / 100);
			   }
			   if (constraints['verticalCenter'] !== undefined) {
				   // verticalCenter 相对于 Group 中心的偏移
				   const nodeCenter = newY + nodeHeight / 2;
				   const groupCenter = groupHeight / 2;
				   const newVC = Math.round((nodeCenter - groupCenter) * 100) / 100;
				   node.setNumber('verticalCenter', newVC);
			   }
		   } else {
			   // 没有垂直约束，使用 y
			   node.setNumber('y', newY);
		   }
		   
		   // 恢复百分比宽高
		   if (percentSize.width) {
			   node.setSize('width', percentSize.width);
		   }
		   if (percentSize.height) {
			   node.setSize('height', percentSize.height);
		   }
	   }
	   groupNode.setSelected(true);
	}
	/**
	 * 删除选中的Group，并把子项都移动出来。
	 * 保留子节点的约束属性，并根据父容器位置重新计算约束值。
	 */
	public unGroupNodes(): void {
		if (!this.canUngroupNodes()) {
			return;
		}
		const nodeList: INode[] = this._model.getSelectedNodes();
		const length: number = nodeList.length;
		const constraintKeys = ['left', 'right', 'top', 'bottom', 'horizontalCenter', 'verticalCenter'];
		
		for (let i = 0; i < length; i++) {
			const groupNode: IContainer = nodeList[i] as IContainer;
			if (!(isInstanceof(groupNode, 'eui.IContainer')) || !groupNode.getParent()
				|| groupNode.getName() !== 'Group' || groupNode.getNs().uri !== EUI.uri
				|| (isInstanceof(groupNode.getParent(), 'eui.ISingleChild'))) {
				continue;
			}
			const parentNode: IContainer = groupNode.getParent();
			const numChildren: number = groupNode.getNumChildren();
			const nodeIndex: number = parentNode.getNodeIndex(groupNode);
			
			// 获取 Group 的实际位置和尺寸
			const groupX = groupNode.getInstance() ? groupNode.getInstance().x : 0;
			const groupY = groupNode.getInstance() ? groupNode.getInstance().y : 0;
			const groupWidth = groupNode.getInstance() ? groupNode.getInstance().width : 0;
			const groupHeight = groupNode.getInstance() ? groupNode.getInstance().height : 0;
			
			// 获取父容器尺寸
			const parentWidth = parentNode.getInstance() ? parentNode.getInstance().width : 0;
			const parentHeight = parentNode.getInstance() ? parentNode.getInstance().height : 0;
			
			for (let index = numChildren - 1; index >= 0; index--) {
				const node: INode = groupNode.getNodeAt(index);
				
				// 保存子节点的约束属性
				const constraints: { [key: string]: any } = {};
				for (const key of constraintKeys) {
					const prop = node.getProperty(key);
					if (prop) {
						const value = prop.getInstance();
						if (value !== null && value !== undefined) {
							constraints[key] = value;
						}
					}
				}
				
				// 保存百分比宽高
				const percentSize: { width?: string; height?: string } = {};
				const widthProp = node.getProperty('width');
				if (widthProp && typeof widthProp.getInstance() === 'string') {
					percentSize.width = widthProp.getInstance();
				}
				const heightProp = node.getProperty('height');
				if (heightProp && typeof heightProp.getInstance() === 'string') {
					percentSize.height = heightProp.getInstance();
				}
				
				// 获取节点在 Group 中的实际位置和尺寸
				const nodeX = node.getInstance() ? node.getInstance().x : 0;
				const nodeY = node.getInstance() ? node.getInstance().y : 0;
				const nodeWidth = node.getInstance() ? node.getInstance().width : 0;
				const nodeHeight = node.getInstance() ? node.getInstance().height : 0;
				
				// 计算子节点在父容器中的新位置
				const newX = Math.round((groupX + nodeX) * 100) / 100;
				const newY = Math.round((groupY + nodeY) * 100) / 100;
				
				// 先清除约束属性
				for (const key of constraintKeys) {
					node.setProperty(key, null);
				}
				
				// 移动节点到父容器
				parentNode.addNodeAt(node, nodeIndex);
				
				// 根据原约束类型重新计算相对于父容器的约束值
				const hasHorizontalConstraint = constraints['left'] !== undefined || 
					constraints['right'] !== undefined || 
					constraints['horizontalCenter'] !== undefined;
				const hasVerticalConstraint = constraints['top'] !== undefined || 
					constraints['bottom'] !== undefined || 
					constraints['verticalCenter'] !== undefined;
				
				if (hasHorizontalConstraint) {
					if (constraints['left'] !== undefined) {
						// left 相对于父容器左边的距离
						node.setNumber('left', newX);
					}
					if (constraints['right'] !== undefined) {
						// right 相对于父容器右边的距离
						const newRight = parentWidth - newX - nodeWidth;
						node.setNumber('right', Math.round(newRight * 100) / 100);
					}
					if (constraints['horizontalCenter'] !== undefined) {
						// horizontalCenter 相对于父容器中心的偏移
						const nodeCenter = newX + nodeWidth / 2;
						const parentCenter = parentWidth / 2;
						const newHC = Math.round((nodeCenter - parentCenter) * 100) / 100;
						node.setNumber('horizontalCenter', newHC);
					}
				} else {
					node.setNumber('x', newX);
				}
				
				if (hasVerticalConstraint) {
					if (constraints['top'] !== undefined) {
						// top 相对于父容器顶部的距离
						node.setNumber('top', newY);
					}
					if (constraints['bottom'] !== undefined) {
						// bottom 相对于父容器底部的距离
						const newBottom = parentHeight - newY - nodeHeight;
						node.setNumber('bottom', Math.round(newBottom * 100) / 100);
					}
					if (constraints['verticalCenter'] !== undefined) {
						// verticalCenter 相对于父容器中心的偏移
						const nodeCenter = newY + nodeHeight / 2;
						const parentCenter = parentHeight / 2;
						const newVC = Math.round((nodeCenter - parentCenter) * 100) / 100;
						node.setNumber('verticalCenter', newVC);
					}
				} else {
					node.setNumber('y', newY);
				}
				
				// 恢复百分比宽高
				if (percentSize.width) {
					node.setSize('width', percentSize.width);
				}
				if (percentSize.height) {
					node.setSize('height', percentSize.height);
				}
				
				node.setSelected(true);
			}
			parentNode.removeNode(groupNode);
		}
	}
	/**
	 * 是否可以将节点解组
	 */
	public canUngroupNodes(): boolean {
		const nodeList: INode[] = this._model.getSelectedNodes();
		const length: number = nodeList.length;
		for (let i = 0; i < length; i++) {
			const groupNode: IContainer = nodeList[i] as IContainer;
			if (!(isInstanceof(groupNode, 'eui.IContainer')) || !groupNode.getParent()
				|| groupNode.getName() !== 'Group' || groupNode.getNs().uri !== EUI.uri
				|| (isInstanceof(groupNode.getParent(), 'eui.ISingleChild'))) {
				continue;
			}
			return true;
		}
		return false;
	}
	/**
	 * 选择指定节点
	 * @param target 
	 */
	public select(target: INode | INode[]): void {
		const selectedNodes = this._model.getSelectedNodes();
		for (var i = 0; i < selectedNodes.length; i++) {
			const node: INode = selectedNodes[i];
			node.setSelected(false);
		}
		if (target) {
			if (isArray(target)) {
				for (var i = 0; i < target.length; i++) {
					target[i].setSelected(true);
				}
			} else {
				target.setSelected(true);
			}
		}
	}
	/**
	 * 选择全部节点
	 */
	public selectAll(): void {
		const container: IContainer = this.rootNode as IContainer;
		if (!(isInstanceof(container, 'eui.IContainer'))) {
			return;
		}
		for (var i = 0; i < this._model.getSelectedNodes().length; i++) {
			const node: INode = this._model.getSelectedNodes()[i];
			if (node.getParent() !== container) {
				node.setSelected(false);
			}
		}
		for (var i = container.getNumChildren() - 1; i >= 0; i--) {
			container.getNodeAt(i).setSelected(true);
		}
	}

	/**
	 * 是否可以转换成内嵌节点
	 * @param node 
	 */
	public canConvertToInner(node: INode): boolean {
		let classValue: IClass;
		if (this.getModel().getExmlConfig().isInstance(node.getInstance(), 'eui.Component')) {
			classValue = node.getProperty('skinName') as IClass;
		}
		else if (this.getModel().getExmlConfig().isInstance(node.getInstance(), 'eui.DataGroup')) {
			classValue = node.getProperty('itemRendererSkinName') as IClass;
		}
		else {
			return false;
		}
		if (!classValue || !classValue.getIsInner()) {
			return true;
		}
		return false;
	}


	/**
	 * 转换为内嵌节点
	 * @param node 
	 */
	public convertToInner(node: INode): Promise<IClass> {
		let classValue: IClass;
		let className: string;
		let classXML: sax.Tag;
		let propertyName: string;
		if (this.getModel().getExmlConfig().isInstance(node.getInstance(), 'eui.Component')) {
			propertyName = 'skinName';
			classValue = node.getProperty(propertyName) as IClass;
		}
		else if (this.getModel().getExmlConfig().isInstance(node.getInstance(), 'eui.DataGroup')) {
			propertyName = 'itemRendererSkinName';
			classValue = node.getProperty(propertyName) as IClass;
			node.setProperty('itemRenderer', null);
		}

		if (classValue && !classValue.getIsInner() && classValue.getClassName()) {
			className = classValue.getClassName();
		}
		else {
			let nodeClassName: string = this.getModel().getExmlConfig().getClassNameById(node.getName(), node.getNs());
			if (propertyName === 'itemRendererSkinName') {
				nodeClassName = 'eui.ItemRenderer';
			}
			className = this.getModel().getExmlConfig().getDefaultSkinNameByClassName(nodeClassName);
		}

		if (className) {
			const pathUri = this.getModel().getExmlConfig().getProjectConfig().getExmlUri(className);
			const path: string = pathUri ? pathUri.fsPath : '';
			if (endWith(path.toLowerCase(), '.exml')) {
				try {
					//TODO 用fileservice改为异步
					classXML = xmlTagUtil.parse(fs.readFileSync(path, { encoding: 'utf8' }));
					if (classXML.attributes['class']) {
						xmlTagUtil.deleteAttribute(classXML, 'class');
					}
				} catch (error) {
				}
			}
		}

		if (!classXML) {
			classXML = xmlTagUtil.parse('<e:Skin xmlns:e=\"' + EUI.uri + '\" states=\"up,down,disabled\"></e:Skin>');
		}
		classValue = this.getModel().createIClass(null, classXML);
		node.setProperty(propertyName, classValue);
		return Promise.resolve(classValue);
	}

	/**
	 * 根节点对象
	 */
	public get rootNode(): INode {
		return this.getModel() ? this.getModel().getRootNode() : null;
	}

	/**
	 * 复制选中的节点到系统剪贴板
	 */
	public copyNodesToClipboard(): void {
		if (!this.getModel()) {
			return;
		}
		this.getModel().copyNodesToClipboard();
	}

	/**
	 * 剪切选中的节点到系统剪贴板
	 */
	public cutNodesToClipboard(): void {
		if (!this.getModel()) {
			return;
		}
		this.getModel().cutNodesToClipboard();
	}
	/**
	 * 粘贴系统剪贴板中的节点
	 */
	public pasteNodesFromClipboard(): void {
		if (!this.getModel()) {
			return;
		}
		this.getModel().pasteNodesFromClipboard();
	}
	/**
	 * 删除选中的节点,返回删除的节点列表。
	 */
	public removeSelectedNodes(): INode[] {
		if (!this.getModel()) {
			return [];
		}
		return this.getModel().removeSelectedNodes();
	}
	/**
	 * 复制节点的属性
	 */
	public copyNodeProperty(): void {
		if (!this.getModel()) {
			return;
		}
		if (this.getModel().getSelectedNodes().length > 0) {
			copypAllPropertyToClipboard(this.getModel().getSelectedNodes()[0]);
		}
	}
	/**
	 * 粘贴节点位置
	 */
	public pasteNodePos(): void {
		if (!this.getModel()) {
			return;
		}
		pastePosFromClipboard(this.getModel().getSelectedNodes());
	}
	/**
	 * 粘贴节点尺寸
	 */
	public pasteNodeSize(): void {
		if (!this.getModel()) {
			return;
		}
		pasteSizeFromClipboard(this.getModel().getSelectedNodes());
	}
	/**
	 * 粘贴节点约束条件
	 */
	public pasteNodeRestrict(): void {
		if (!this.getModel()) {
			return;
		}
		pasteRestrictFromClipboard(this.getModel().getSelectedNodes());
	}

	/**
	 * 释放
	 */
	public dispose(): void {
		this._model = null;
	}
}