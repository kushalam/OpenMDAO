// <<hpp_insert gen/Scale.js>>
// <<hpp_insert gen/Dimensions.js>>

/**
 * Calculates and stores the size and positions of visible elements.
 * @typedef Layout
 * @property {ModelData} model Reference to the preprocessed model.
 * @property {OmTreeNode} zoomedElement Reference to zoomedElement managed by N2Diagram.
 * @property {OmTreeNode[]} zoomedNodes  Child workNodes of the current zoomed element.
 * @property {OmTreeNode[]} visibleNodes Zoomed workNodes that are actually drawn.
 * @property {Object} svg Reference to the top-level SVG element in the document.
 * @property {Object} size The dimensions of the model tree.
 * @property {Object} scales Scalers in the X and Y directions to associate the relative
 *   position of an element to actual pixel coordinates.
 * @property {Object} transitCoords
 */
class Layout {
    /**
     * Compute the new layout based on the model data and the zoomed element.
     * @param {ModelData} model The pre-processed model object.
     * @param {Object} newZoomedElement The element the new layout is based around.
     * @param {Object} dims The initial sizes for multiple tree elements.
     * @param {Boolean} callInit Whether to call _init() or have a subclass do it.
     */
    constructor(model, newZoomedElement, dims, callInit = true) {
        this.model = model;

        this.zoomedElement = newZoomedElement;

        this.zoomedNodes = [];
        this.visibleNodes = [];

        this.curVisibleNodeCount = 0;
        this.prevVisibleNodeCount = 0;

        // Initial size values derived from read-only defaults
        this.size = dims.size;
        this.svg = d3.select("#svgId");

        if (callInit) this._init();
    }

    _init() {
        this._computeLeaves();
        this._setupTextRenderer();
        this._updateTextWidths();
        delete (this.textRenderer);
        this._computeColumnWidths();
        this._setColumnLocations(this.size.partitionTree, this.cols);

        this._computeNormalizedPositions(this.model.root, 0, false, null);
        if (this.zoomedElement.parent)
            this.zoomedNodes.push(this.zoomedElement.parent);

        this.setTransitionPermission();

        this.scales = {
            model: new Scale(this.size.partitionTree),
            firstRun: true
        }

        this.transitCoords = {
            model: new Dimensions({ x: 0, y: 0})
        }
    }

    /**
     * If there are too many nodes, don't bother with transition animations
     * because it will cause lag and may timeout anyway. This is accomplished
     * by redefining a few D3 methods to return the same selection instead
     * of a transition object. When the number of nodes is low enough,
     * the original transition methods are restored.
     */
    setTransitionPermission() {
        this.prevVisibleNodeCount = this.visibleNodeCount;
        this.visibleNodeCount = this.visibleNodes.length;
        const highWaterMark = Math.max(this.prevVisibleNodeCount, this.visibleNodeCount);

        // Too many nodes, disable transitions.
        if (highWaterMark >= N2TransitionDefaults.maxNodes) {
            debugInfo("Denying transitions: ", this.visibleNodes.length,
                " visible nodes, max allowed: ", N2TransitionDefaults.maxNodes)

            // Return if already denied
            if (!d3.selection.prototype.transitionAllowed) return;
            d3.selection.prototype.transitionAllowed = false;

            d3.selection.prototype.transition = returnThis;
            d3.selection.prototype.duration = returnThis;
            d3.selection.prototype.delay = returnThis;
        }
        else { // OK, enable transitions.
            debugInfo("Allowing transitions: ", this.visibleNodes.length,
                " visible nodes, max allowed: ", N2TransitionDefaults.maxNodes)

            // Return if already allowed
            if (d3.selection.prototype.transitionAllowed) return;
            d3.selection.prototype.transitionAllowed = true;

            for (const func in d3.selection.prototype.originalFuncs) {
                d3.selection.prototype[func] =
                    d3.selection.prototype.originalFuncs[func];
            }
        }
    }

    /** Create an off-screen area to render text for _getTextWidth() */
    _setupTextRenderer() {
        const textGroup = this.svg.select('#text-width-renderer');
        const textSVG = textGroup.select('text');

        this.textRenderer = {
            'group': textGroup,
            'textSvg': textSVG,
            'workNode': textSVG.node(),
            'widthCache': {}
        };
    }

    /** Insert text into an off-screen SVG text object to determine the width.
     * Cache the result so repeat calls with the same text can just do a lookup.
     * @param {string} text Text to render or find in cache.
     * @return {number} The SVG-computed width of the rendered string.
     */
    _getTextWidth(text) {
        let width = 0.0;

        // Check cache first
        if (this.textRenderer.widthCache.propExists(text)) {
            width = this.textRenderer.widthCache[text];
        }
        else {
            // Not found, render and return new width.
            this.textRenderer.textSvg.text(text);
            width = this.textRenderer.workNode.getBoundingClientRect().width;

            this.textRenderer.widthCache[text] = width;
        }

        return width;
    }

    /** Determine the text associated with the node. Normally its name,
     * but can be changed if promoted.
     * @param {OmTreeNode} node The item to operate on.
     * @return {string} The selected text.
     */
    getText(node) {
        let retVal = node.name;

        if (node.name == '_auto_ivc') {
            retVal = 'Auto-IVC';
        }
        else if (node.isFilter()) {
            if (node.name.match(/.*_N2_FILTER_inputs$/)) retVal = 'Filtered Inputs';
            else retVal = 'Filtered Outputs';
        }
        else if (node.absPathName.match(/^_auto_ivc.*/) && node.promotedName !== undefined) {
            retVal = node.promotedName;
        }

        return retVal;
    }

    /**
     * Determine text widths for all descendents of the specified node.
     * @param {OmTreeNode} [node = this.zoomedElement] Item to begin looking from.
     */
    _updateTextWidths(node = this.zoomedElement) {
        if (node.draw.hidden) return;

        node.draw.nameWidthPx = this._getTextWidth(this.getText(node)) + 2 *
            this.size.rightTextMargin;

        if (node.hasChildren() && !node.draw.minimized) {
            for (const child of node.children) {
                this._updateTextWidths(child);
            }
        }
    }

    /**
     * Recurse through the tree and add up the number of leaves that each
     * node has, based on their array of visible children.
     * @param {OmTreeNode} [node = this.model.root] The starting node.
     */
    _computeLeaves(node = this.model.root) {
        node.draw.numLeaves = 0;

        if (!(node.draw.hidden || node.draw.filtered)) {
            if (node.name == '_auto_ivc' && !node.draw.manuallyExpanded) {
                node.minimize();
            }
            else if (this.model.nodeIds.length > Precollapse.minimumNodes) {
                node.minimizeIfLarge(this.model.depthCount[node.depth]);
            }

            if (node.hasChildren() && !node.draw.minimized) {
                for (const child of node.children) {
                    this._computeLeaves(child);
                    node.draw.numLeaves += child.draw.numLeaves;
                }
            }
            else {
                node.draw.numLeaves = 1; // Leaf node
            }
        }
    }

    /**
     * For visible nodes with children, choose a column width
     * large enough to accomodate the widest label in their column.
     * @param {OmTreeNode} node The item to operate on.
     * @param {string} childrenProp Either 'children' or 'subsystem_children'.
     * @param {Object[]} colArr The array of column info.
     * @param {number[]} leafArr The array of leaf width info.
     * @param {string} widthProp Either 'nameWidthPx' or 'nameSolverWidthPx'.
     */
    _setColumnWidthsFromWidestText(node, childrenProp, colArr, leafArr, widthProp) {
        if (node.draw.hidden) return;

        const height = this.size.n2matrix.height * node.draw.numLeaves / this.zoomedElement.draw.numLeaves;
        node.prevTextOpacity = node.propExists('textOpacity') ? node.textOpacity : 0;
        node.textOpacity = (height > this.size.font) ? 1 : 0;
        const hasVisibleDetail = (height >= 2.0);
        let width = (hasVisibleDetail) ? this.size.minColumnWidth : 1e-3;
        if (node.textOpacity > 0.5) width = node.draw[widthProp];

        this.greatestDepth = Math.max(this.greatestDepth, node.depth);

        if (node.hasChildren(childrenProp) && !node.draw.minimized) { //not leaf
            colArr[node.depth].width = Math.max(colArr[node.depth].width, width)
            for (const child of node[childrenProp]) {
                this._setColumnWidthsFromWidestText(child, childrenProp, colArr, leafArr, widthProp);
            }
        }
        else if (!node.draw.filtered) { // leaf
            leafArr[node.depth] = Math.max(leafArr[node.depth], width);
        }
    }

    /**
     * Compute column widths across the model, then adjust ends as needed.
     * @param {OmTreeNode} [node = this.zoomedElement] Item to operate on.
     */
    _computeColumnWidths(node = this.zoomedElement) {
        this.greatestDepth = 0;
        this.leafWidthsPx = new Array(this.model.maxDepth + 1).fill(0.0);
        this.cols = Array.from({length: this.model.maxDepth + 1},
            () => ({ 'width': 0.0, 'location': 0.0 }));

        this._setColumnWidthsFromWidestText(node, 'children', this.cols,
            this.leafWidthsPx, 'nameWidthPx');

        let sum = 0;
        let lastColumnWidth = 0;
        for (let i = this.leafWidthsPx.length - 1; i >= this.zoomedElement.depth; --i) {
            sum += this.cols[i].width;
            const lastWidthNeeded = this.leafWidthsPx[i] - sum;
            lastColumnWidth = Math.max(lastWidthNeeded, lastColumnWidth);
        }

        this.cols[this.zoomedElement.depth - 1].width = this.size.parentNodeWidth;
        this.cols[this.greatestDepth].width = lastColumnWidth;
    }

    /** Set the location of the columns based on the width of the columns to the left. */
    _setColumnLocations(obj, cols) {
        obj.width = 0;

        for (let depth = 1; depth <= this.model.maxDepth; ++depth) {
            cols[depth].location = obj.width;
            obj.width += cols[depth].width;
        }
    }

    /**
     * Recurse over the model tree and determine the coordinates and
     * size of visible nodes. If a parent is minimized, operations are
     * performed on it instead.
     * @param {OmTreeNode} node The node to operate on.
     * @param {number} leafCounter Tally of leaves encountered so far.
     * @param {Boolean} isChildOfZoomed Whether node is a descendant of this.zoomedElement.
     * @param {Object} earliestMinimizedParent The minimized parent, if any, appearing
     *   highest in the tree hierarchy. Null if none exist.
     */
    _computeNormalizedPositions(node, leafCounter, isChildOfZoomed, earliestMinimizedParent) {
        if (!isChildOfZoomed) {
            isChildOfZoomed = (node === this.zoomedElement);
        }

        if (earliestMinimizedParent == null && isChildOfZoomed) {
            if (node.isVisible()) {
                this.zoomedNodes.push(node)
                if (node.isVisibleLeaf()) {
                    if (!node.draw.hidden) this.visibleNodes.push(node);
                    earliestMinimizedParent = node;
                }
            }
        }

        node.preserveDims(false, leafCounter);
        const workNode = (earliestMinimizedParent) ? earliestMinimizedParent : node;
        const dims = node.draw.dims;

        if (! node.isVisible()) { // input or hidden leaf leaving
            dims.x = this.cols[node.parentComponent.depth + 1].location / this.size.partitionTree.width;
            dims.y = node.parentComponent.draw.dims.y;
            dims.width = 1e-6;
            dims.height = 1e-6;
        }
        else {
            dims.x = this.cols[workNode.depth].location / this.size.partitionTree.width;
            dims.y = leafCounter / this.model.root.draw.numLeaves;
            dims.width = (node.hasChildren() && !node.draw.minimized && !node.draw.filtered) ?
                (this.cols[workNode.depth].width / this.size.partitionTree.width) : 1 - workNode.draw.dims.x;
            dims.height = workNode.draw.numLeaves / this.model.root.draw.numLeaves;
        }

        if (node.hasChildren()) {
            for (const child of node.children) {
                if (!child.isInputOrOutput() || !child.draw.minimized) {
                    this._computeNormalizedPositions(child, leafCounter,
                        isChildOfZoomed, earliestMinimizedParent);
                    if (earliestMinimizedParent == null) { //numleaves is only valid passed nonminimized nodes
                        leafCounter += child.draw.numLeaves;
                    }
                }
            }
        }
    }

    /**
     * Calculate new dimensions for the div element enclosing the main SVG element.
     * @returns {Object} Members width and height as strings with the unit appended.
     */
    newOuterDims() {
        let width = (this.size.partitionTree.width +
            this.size.n2matrix.margin +
            this.size.n2matrix.width +
            this.size.n2matrix.margin);

        let height = (this.size.n2matrix.height +
            this.size.n2matrix.margin * 2);

        return {'width': width, 'height': height};
    }

    /**
     * Calculate new dimensions for the main SVG element.
     * @returns {Object} Members width and height as numbers.
     */
    newInnerDims() {
        let width = this.size.partitionTree.width +
            this.size.n2matrix.margin +
            this.size.n2matrix.width +
            this.size.n2matrix.margin;

        let height = this.size.partitionTree.height;
        let margin = this.size.n2matrix.margin;

        return {'width': width, 'height': height, 'margin': margin};
    }

    /**
     * Update container element dimensions when a new layout is calculated,
     * and set up transitions.
     * @param {Object} dom References to HTML elements.
     * @param {number} transitionStartDelay ms to wait before performing transition
     */
    updateTransitionInfo(dom, transitionStartDelay, manuallyResized) {

        sharedTransition = d3.transition()
            .duration(N2TransitionDefaults.duration)
            .delay(transitionStartDelay)
            // Hide the transition waiting animation when it ends:
            .on('end', function () { dom.waiter.attr('class', 'no-show'); });

        this.transitionStartDelay = N2TransitionDefaults.startDelay;

        const outerDims = this.newOuterDims();
        const innerDims = this.newInnerDims();

        this.ratio = (window.innerWidth - 200) / outerDims.width;
        if (this.ratio > 1 || manuallyResized) this.ratio = 1;
        else if (this.ratio < 1)
            debugInfo("Scaling diagram to " + Math.round(this.ratio * 100) + "%");

        dom.svgDiv
            .style("width", (outerDims.width * this.ratio) + this.size.unit)
            .style("height", (outerDims.height * this.ratio) + this.size.unit)

        dom.svg
            .transition(sharedTransition)
            .style("transform", "scale(" + this.ratio + ")")
            .attr("width", outerDims.width + this.size.unit)
            .attr("height", outerDims.height + this.size.unit);

        this.gapDist = (this.size.partitionTreeGap * this.ratio) - 3;
        this.gapSpace = this.gapDist + this.size.unit
        d3.select('#n2-resizer-box')
            .transition(sharedTransition)
            .style('bottom', this.gapSpace);

        dom.pTreeGroup
            .transition(sharedTransition)
            .attr("height", innerDims.height)
            .attr("width", this.size.partitionTree.width)
            .attr("transform", "translate(0 " + innerDims.margin + ")");

        dom.highlightBar
            .transition(sharedTransition)
            .attr("height", innerDims.height)
            .attr("width", "8")
            .attr("transform", "translate(" + this.size.partitionTree.width + 1 + " " + innerDims.margin + ")");

        // Move n2 outer group to right of partition tree, spaced by the margin.
        dom.n2OuterGroup
            .transition(sharedTransition)
            .attr("height", outerDims.height)
            .attr("width", outerDims.height)
            .attr("transform", "translate(" +
                (this.size.partitionTree.width) + " 0)");

        dom.n2InnerGroup.transition(sharedTransition)
            .attr("height", innerDims.height)
            .attr("width", innerDims.height)
            .attr("transform", "translate(" + innerDims.margin + " " + innerDims.margin + ")");

        dom.n2BackgroundRect.transition(sharedTransition)
            .attr("width", innerDims.height)
            .attr("height", innerDims.height)
            .attr("transform", "translate(0 0)");

    }

    calcWidthBasedOnNewHeight(height) {
        return this.size.partitionTree.width + height + this.size.n2matrix.margin * 2;
    }

    calcHeightBasedOnNewWidth(width) {
        return width - this.size.partitionTree.width - this.size.n2matrix.margin * 2;
    }

    calcFitDims() {
        let height = window.innerHeight * 0.95;
        let width = this.calcWidthBasedOnNewHeight(height);

        if (width > window.innerWidth - 200) {
            width = window.innerWidth - 200;
            height = this.calcHeightBasedOnNewWidth(width);
        }

        return { 'width': width, 'height': height };
    }

    /**
     * Make a copy of the previous transit coordinates and linear scalers before
     * setting new ones.
     */
    preservePreviousScaleValues() {
        this.transitCoords.model.preserve();
        this.scales.model.preserve();
    }

    updateScaleValues() {
        if (!this.scales.firstRun) this.preservePreviousScaleValues();

        const elemDims = this.zoomedElement.draw.dims;
        const treeSize = this.size.partitionTree;

        this.transitCoords.model.x = (elemDims.x ?
            treeSize.width - this.size.parentNodeWidth : treeSize.width) / (1 - elemDims.x);
        this.transitCoords.model.y = treeSize.height / elemDims.height;

        this.scales.model.x
            .domain([elemDims.x, 1])
            .range([elemDims.x ? this.size.parentNodeWidth : 0, treeSize.width]);

        this.scales.model.y
            .domain([elemDims.y, elemDims.y + elemDims.height])
            .range([0, treeSize.height]);
    }
}
