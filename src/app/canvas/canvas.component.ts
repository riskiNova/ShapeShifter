import * as _ from 'lodash';
import * as $ from 'jquery';
import {
  Component, AfterViewInit, OnDestroy, ElementRef, ViewChild,
  Input, ViewChildren, QueryList, ChangeDetectionStrategy
} from '@angular/core';
import { Path, SubPath, Command } from '../scripts/paths';
import {
  PathLayer, ClipPathLayer,
  VectorLayer, GroupLayer, Layer
} from '../scripts/layers';
import { CanvasType } from '../CanvasType';
import { Point, Matrix, MathUtil, ColorUtil } from '../scripts/common';
import {
  AnimatorService,
  CanvasResizeService,
  AppModeService, AppMode,
  SelectionService, SelectionType,
  StateService, MorphabilityStatus,
  HoverService, HoverType, Hover,
  SettingsService,
} from '../services';
import { CanvasRulerDirective } from './canvasruler.directive';
import { Observable } from 'rxjs/Observable';
import { Subscription } from 'rxjs/Subscription';
import { SegmentSplitter } from './SegmentSplitter';
import { PathSelector } from './PathSelector';
import { ShapeSplitter } from './ShapeSplitter';

const SPLIT_POINT_RADIUS_FACTOR = 0.8;
const SELECTED_POINT_RADIUS_FACTOR = 1.25;
const POINT_BORDER_FACTOR = 1.075;
const DISABLED_ALPHA = 0.38;

// Canvas margin in css pixels.
export const CANVAS_MARGIN = 36;
// Default viewport size in viewport pixels.
export const DEFAULT_VIEWPORT_SIZE = 24;
// The line width of a highlight in css pixels.
const HIGHLIGHT_LINE_WIDTH = 6;
// The distance of a mouse gesture that triggers a drag, in css pixels.
const DRAG_TRIGGER_TOUCH_SLOP = 6;
// The minimum distance between a point and a path that causes a snap.
const MIN_SNAP_THRESHOLD = 12;
// The radius of a medium point in css pixels.
const MEDIUM_POINT_RADIUS = 8;
// The radius of a small point in css pixels.
const SMALL_POINT_RADIUS = MEDIUM_POINT_RADIUS / 1.7;
// The size of a dashed outline in css pixels.
const DASH_SIZE = 20;

const NORMAL_POINT_COLOR = '#2962FF'; // Blue A400
const SPLIT_POINT_COLOR = '#E65100'; // Orange 900
const HIGHLIGHT_COLOR = '#448AFF';
const POINT_BORDER_COLOR = '#000';
const POINT_TEXT_COLOR = '#fff';

type Context = CanvasRenderingContext2D;

@Component({
  selector: 'app-canvas',
  templateUrl: './canvas.component.html',
  styleUrls: ['./canvas.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CanvasComponent implements AfterViewInit, OnDestroy {
  @Input() canvasType: CanvasType;
  @ViewChild('canvasContainer') private canvasContainerRef: ElementRef;
  @ViewChild('renderingCanvas') private renderingCanvasRef: ElementRef;
  @ViewChild('overlayCanvas') private overlayCanvasRef: ElementRef;
  @ViewChildren(CanvasRulerDirective) canvasRulers: QueryList<CanvasRulerDirective>;

  private canvasContainer: JQuery;
  private renderingCanvas: JQuery;
  private overlayCanvas: JQuery;
  private offscreenLayerCanvas: JQuery;
  private offscreenSubPathCanvas: JQuery;
  private renderingCtx: Context;
  private overlayCtx: Context;
  private offscreenLayerCtx: Context;
  private offscreenSubPathCtx: Context;
  private isViewInit: boolean;
  private cssContainerWidth = 1;
  private cssContainerHeight = 1;
  private vlSize = { width: DEFAULT_VIEWPORT_SIZE, height: DEFAULT_VIEWPORT_SIZE };
  private cssScale: number;
  private attrScale: number;
  private currentHoverPreviewPath: Path;
  private pathSelector: PathSelector | undefined;
  private segmentSplitter: SegmentSplitter | undefined;
  private shapeSplitter: ShapeSplitter | undefined;
  private readonly subscriptions: Subscription[] = [];

  // TODO: use this somehow in the UI?
  private disabledSubPathIndices: number[] = [];

  constructor(
    private readonly elementRef: ElementRef,
    readonly appModeService: AppModeService,
    private readonly canvasResizeService: CanvasResizeService,
    readonly hoverService: HoverService,
    readonly stateService: StateService,
    private readonly animatorService: AnimatorService,
    readonly selectionService: SelectionService,
    private readonly settingsService: SettingsService,
  ) { }

  ngAfterViewInit() {
    this.isViewInit = true;
    this.canvasContainer = $(this.canvasContainerRef.nativeElement);
    this.renderingCanvas = $(this.renderingCanvasRef.nativeElement);
    this.overlayCanvas = $(this.overlayCanvasRef.nativeElement);
    this.offscreenLayerCanvas = $(document.createElement('canvas'));
    this.offscreenSubPathCanvas = $(document.createElement('canvas'));
    const getCtxFn = (canvas: JQuery) => {
      return (canvas.get(0) as HTMLCanvasElement).getContext('2d');
    };
    this.renderingCtx = getCtxFn(this.renderingCanvas);
    this.overlayCtx = getCtxFn(this.overlayCanvas);
    this.offscreenLayerCtx = getCtxFn(this.offscreenLayerCanvas);
    this.offscreenSubPathCtx = getCtxFn(this.offscreenSubPathCanvas);
    this.subscriptions.push(
      this.stateService.getVectorLayerObservable(this.canvasType)
        .subscribe(vl => {
          const newWidth = vl ? vl.width : DEFAULT_VIEWPORT_SIZE;
          const newHeight = vl ? vl.height : DEFAULT_VIEWPORT_SIZE;
          const didSizeChange =
            this.vlSize.width !== newWidth || this.vlSize.height !== newHeight;
          this.vlSize = { width: newWidth, height: newHeight };
          if (didSizeChange) {
            this.resizeAndDraw();
          } else {
            this.draw();
          }
        }));
    this.subscriptions.push(
      this.canvasResizeService.asObservable()
        .subscribe(size => {
          const oldWidth = this.cssContainerWidth;
          const oldHeight = this.cssContainerHeight;
          this.cssContainerWidth = Math.max(1, size.width - CANVAS_MARGIN * 2);
          this.cssContainerHeight = Math.max(1, size.height - CANVAS_MARGIN * 2);
          if (this.cssContainerWidth !== oldWidth
            || this.cssContainerHeight !== oldHeight) {
            this.resizeAndDraw();
          }
        }));
    if (this.canvasType === CanvasType.Preview) {
      // Preview canvas specific setup.
      const interpolatePreview = () => {
        const fraction = this.animatorService.getAnimatedValue();
        const startPathLayer = this.stateService.getActivePathLayer(CanvasType.Start);
        const previewPathLayer = this.stateService.getActivePathLayer(CanvasType.Preview);
        const endPathLayer = this.stateService.getActivePathLayer(CanvasType.End);
        if (startPathLayer && previewPathLayer && endPathLayer
          && startPathLayer.isMorphableWith(endPathLayer)) {
          // Note that there is no need to broadcast layer state changes
          // for the preview canvas.
          previewPathLayer.interpolate(startPathLayer, endPathLayer, fraction);
        }
        const startGroupLayer = this.stateService.getActiveRotationLayer(CanvasType.Start);
        const previewGroupLayer = this.stateService.getActiveRotationLayer(CanvasType.Preview);
        const endGroupLayer = this.stateService.getActiveRotationLayer(CanvasType.End);
        if (startGroupLayer && previewGroupLayer && endGroupLayer) {
          previewGroupLayer.interpolate(startGroupLayer, endGroupLayer, fraction);
        }
        const startVectorLayer = this.stateService.getVectorLayer(CanvasType.Start);
        const previewVectorLayer = this.stateService.getVectorLayer(CanvasType.Preview);
        const endVectorLayer = this.stateService.getVectorLayer(CanvasType.End);
        if (startVectorLayer && previewVectorLayer && endVectorLayer) {
          previewVectorLayer.interpolate(startVectorLayer, endVectorLayer, fraction);
        }
        this.draw();
      };
      this.subscribeTo(
        this.stateService.getActivePathIdObservable(this.canvasType),
        () => interpolatePreview());
      this.subscribeTo(
        this.animatorService.getAnimatedValueObservable(),
        () => interpolatePreview());
      this.subscribeTo(this.settingsService.getSettingsObservable());
      this.subscribeTo(this.stateService.getMorphabilityStatusObservable());
    } else {
      // Non-preview canvas specific setup.
      this.subscribeTo(this.stateService.getActivePathIdObservable(this.canvasType));
      this.subscribeTo(this.selectionService.asObservable(), () => this.drawOverlays());
      this.subscribeTo(
        this.appModeService.asObservable(),
        () => {
          if (this.appMode === AppMode.AddPoints
            || (this.appMode === AppMode.SplitSubPaths
              && this.activePathLayer
              && this.activePathLayer.isStroked())) {
            this.showPenCursor();
            const subIdxs = new Set<number>();
            for (const s of this.selectionService.getSelections()) {
              subIdxs.add(s.subIdx);
            }
            const toArray = Array.from(subIdxs);
            const restrictToSubIdx = toArray.length ? toArray[0] : undefined;
            this.segmentSplitter = new SegmentSplitter(this, restrictToSubIdx);
          } else {
            this.segmentSplitter = undefined;
          }
          if (this.appMode === AppMode.SelectPoints) {
            this.resetCursor();
            this.pathSelector = new PathSelector(this);
          } else {
            this.pathSelector = undefined;
          }
          if (this.appMode === AppMode.SplitSubPaths
            && this.activePathLayer
            && this.activePathLayer.isFilled()) {
            this.showPenCursor();
            this.shapeSplitter = new ShapeSplitter(this);
          } else {
            this.shapeSplitter = undefined;
          }
          if (this.appMode !== AppMode.AddPoints) {
            this.selectionService.reset();
          }
          this.hoverService.reset();
          this.draw();
        });
      const updateCurrentHoverFn = (hover: Hover | undefined) => {
        let previewPath: Path = undefined;
        if (this.shouldDrawLayers && hover) {
          // If the user is hovering over the inspector split button, then build
          // a snapshot of what the path would look like after the action
          // and display the result.
          const mutator = this.activePath.mutate();
          const { type, subIdx, cmdIdx } = hover;
          switch (type) {
            case HoverType.Split:
              previewPath = mutator.splitCommandInHalf(subIdx, cmdIdx).build();
              break;
            case HoverType.Unsplit:
              previewPath = mutator.unsplitCommand(subIdx, cmdIdx).build();
              break;
            case HoverType.Reverse:
              previewPath = mutator.reverseSubPath(subIdx).build();
              break;
            case HoverType.ShiftForward:
              previewPath = mutator.shiftSubPathForward(subIdx).build();
              break;
            case HoverType.ShiftBack:
              previewPath = mutator.shiftSubPathBack(subIdx).build();
              break;
          }
        }
        this.currentHoverPreviewPath = previewPath;
        this.drawOverlays();
      };
      this.subscribeTo(
        this.hoverService.asObservable(),
        hover => {
          if (!hover) {
            // Clear the current hover.
            updateCurrentHoverFn(undefined);
            return;
          }
          if (hover.source !== this.canvasType
            && hover.type !== HoverType.Point) {
            updateCurrentHoverFn(undefined);
            return;
          }
          updateCurrentHoverFn(hover);
        });
    }
    this.resizeAndDraw();
  }

  ngOnDestroy() {
    this.subscriptions.forEach(s => s.unsubscribe());
  }

  private subscribeTo<T>(
    observable: Observable<T>,
    callbackFn: (t?: T) => void = () => this.draw()) {

    this.subscriptions.push(observable.subscribe(callbackFn));
  }

  private get vectorLayer() {
    return this.stateService.getVectorLayer(this.canvasType);
  }

  private get activePathId() {
    return this.stateService.getActivePathId(this.canvasType);
  }

  get activePathLayer() {
    return this.activePathId
      ? this.stateService.getActivePathLayer(this.canvasType)
      : undefined;
  }

  get activePath() {
    return this.activePathId
      ? this.stateService.getActivePathLayer(this.canvasType).pathData
      : undefined;
  }

  private get shouldDrawLayers() {
    return this.vectorLayer && this.activePathId;
  }

  private get currentHover() {
    return this.hoverService.getHover();
  }

  private get appMode() {
    return this.appModeService.getAppMode();
  }

  private get shouldDisableLayer() {
    return this.canvasType === CanvasType.Preview
      && this.stateService.getMorphabilityStatus() !== MorphabilityStatus.Morphable;
  }

  private get shouldLabelPoints() {
    return this.canvasType !== CanvasType.Preview
      || this.settingsService.shouldLabelPoints();
  }

  private get shouldProcessMouseEvents() {
    return this.canvasType !== CanvasType.Preview && this.activePathId;
  }

  private get transformsForActiveLayer() {
    return getTransformsForLayer(this.vectorLayer, this.activePathId);
  }

  private get smallPointRadius() {
    return SMALL_POINT_RADIUS / this.cssScale;
  }

  private get mediumPointRadius() {
    return MEDIUM_POINT_RADIUS / this.cssScale;
  }

  private get highlightLineWidth() {
    return HIGHLIGHT_LINE_WIDTH / this.cssScale;
  }

  private get lineDashLength() {
    return DASH_SIZE / this.cssScale;
  }

  get minSnapThreshold() {
    return MIN_SNAP_THRESHOLD / this.cssScale;
  }

  get dragTriggerTouchSlop() {
    return DRAG_TRIGGER_TOUCH_SLOP / this.cssScale;
  }

  /**
   * Calculates the projection onto the path with the specified path ID.
   * The resulting projection is our way of determining the on-curve point
   * closest to the specified off-curve mouse point.
   */
  calculateProjectionOntoPath(mousePoint: Point, restrictToSubIdx?: number) {
    const transforms =
      getTransformsForLayer(this.vectorLayer, this.activePathId).reverse();
    const transformedMousePoint =
      MathUtil.transformPoint(
        mousePoint,
        MathUtil.flattenTransforms(transforms).invert());
    const projInfo =
      this.activePathLayer.pathData.project(transformedMousePoint, restrictToSubIdx);
    if (!projInfo) {
      return undefined;
    }
    return {
      subIdx: projInfo.subIdx,
      cmdIdx: projInfo.cmdIdx,
      projection: projInfo.projection,
    };
  }

  private pathPointToDrawingCoords(mousePoint: Point) {
    return MathUtil.transformPoint(
      mousePoint,
      Matrix.flatten(...this.transformsForActiveLayer.reverse()));
  }

  showPenCursor() {
    this.canvasContainer.css({ cursor: 'url(/assets/penaddcursorsmall.png) 5 0, auto' });
  }

  showSelectCursor() {
    this.canvasContainer.css({ cursor: 'pointer' });
  }

  resetCursor() {
    this.canvasContainer.css({ cursor: '' });
  }

  performHitTest(mousePoint: Point, opts: HitTestOpts = {}) {
    const transformMatrix =
      Matrix.flatten(...this.transformsForActiveLayer.reverse()).invert();
    const transformedMousePoint = MathUtil.transformPoint(mousePoint, transformMatrix);
    let isPointInRangeFn: (distance: number, cmd: Command) => boolean;
    if (!opts.noPoints) {
      isPointInRangeFn = (distance, cmd) => {
        const multiplyFactor = cmd.isSplit() ? SPLIT_POINT_RADIUS_FACTOR : 1;
        return distance <= this.mediumPointRadius * multiplyFactor;
      };
    }
    let isSegmentInRangeFn: (distance: number, cmd: Command) => boolean;
    if (!opts.noSegments) {
      isSegmentInRangeFn = distance => {
        return distance <= this.activePathLayer.strokeWidth / 2;
      };
    }
    const findShapesInRange = this.activePathLayer.isFilled() && !opts.noShapes;
    const restrictToSubIdx = opts.restrictToSubIdx;
    return this.activePath.hitTest(transformedMousePoint, {
      isPointInRangeFn,
      isSegmentInRangeFn,
      findShapesInRange,
      restrictToSubIdx,
    });
  }

  /**
   * Resizes the canvas and redraws all content.
   */
  private resizeAndDraw() {
    if (!this.isViewInit) {
      return;
    }
    const { width: vlWidth, height: vlHeight } = this.vlSize;
    const vectorAspectRatio = vlWidth / vlHeight;
    const containerAspectRatio = this.cssContainerWidth / this.cssContainerHeight;

    // The 'cssScale' represents the number of CSS pixels per SVG viewport pixel.
    if (vectorAspectRatio > containerAspectRatio) {
      this.cssScale = this.cssContainerWidth / vlWidth;
    } else {
      this.cssScale = this.cssContainerHeight / vlHeight;
    }

    // The 'attrScale' represents the number of physical pixels per SVG viewport pixel.
    this.attrScale = this.cssScale * devicePixelRatio;

    const canvases = [
      this.canvasContainer,
      this.renderingCanvas,
      this.overlayCanvas,
      this.offscreenLayerCanvas,
      this.offscreenSubPathCanvas,
    ];
    const cssWidth = vlWidth * this.cssScale;
    const cssHeight = vlHeight * this.cssScale;
    canvases.forEach(canvas => {
      canvas
        .attr({
          width: cssWidth * devicePixelRatio,
          height: cssHeight * devicePixelRatio,
        })
        .css({
          width: cssWidth,
          height: cssHeight,
        });
    });

    this.draw();
    this.canvasRulers.forEach(r => r.draw());
  }

  /**
   * Redraws all content.
   */
  draw() {
    if (!this.isViewInit) {
      return;
    }

    this.renderingCtx.save();
    this.setupCtxWithViewportCoords(this.renderingCtx);

    const layerAlpha = this.vectorLayer ? this.vectorLayer.alpha : 1;
    const currentAlpha = (this.shouldDisableLayer ? DISABLED_ALPHA : 1) * layerAlpha;
    if (currentAlpha < 1) {
      this.offscreenLayerCtx.save();
      this.setupCtxWithViewportCoords(this.offscreenLayerCtx);
    }

    // If the canvas is disabled, draw the layer to an offscreen canvas
    // so that we can draw it translucently w/o affecting the rest of
    // the layer's appearance.
    const layerCtx = currentAlpha < 1 ? this.offscreenLayerCtx : this.renderingCtx;
    if (this.shouldDrawLayers) {
      const hasDisabledSubPaths = !!this.disabledSubPathIndices.length;
      const subPathCtx = hasDisabledSubPaths ? this.offscreenSubPathCtx : layerCtx;
      if (hasDisabledSubPaths) {
        subPathCtx.save();
        this.setupCtxWithViewportCoords(subPathCtx);
      }

      // Draw any disabled subpaths.
      this.drawPaths(subPathCtx, layer => {
        if (layer.id !== this.activePathId) {
          return [];
        }
        return _.flatMap(layer.pathData.getSubPaths() as SubPath[],
          (subPath, subIdx) => {
            return this.disabledSubPathIndices.indexOf(subIdx) >= 0
              ? subPath.getCommands() as Command[] : [];
          });
      });
      if (hasDisabledSubPaths) {
        this.drawTranslucentOffscreenCtx(layerCtx, subPathCtx, DISABLED_ALPHA);
        subPathCtx.restore();
      }

      // Draw any enabled subpaths.
      this.drawPaths(layerCtx, layer => {
        if (layer.id !== this.activePathId) {
          return [];
        }
        return _.flatMap(layer.pathData.getSubPaths() as SubPath[],
          (subPath, subIdx) => {
            return this.disabledSubPathIndices.indexOf(subIdx) >= 0
              ? [] : subPath.getCommands() as Command[];
          });
      });
    }

    if (currentAlpha < 1) {
      this.drawTranslucentOffscreenCtx(
        this.renderingCtx, this.offscreenLayerCtx, currentAlpha);
      this.offscreenLayerCtx.restore();
    }
    this.renderingCtx.restore();

    this.drawOverlays();
  }

  // Scale the canvas so that everything from this point forward is drawn
  // in terms of the SVG's viewport coordinates.
  private setupCtxWithViewportCoords = (ctx: Context) => {
    ctx.scale(this.attrScale, this.attrScale);
    ctx.clearRect(0, 0, this.vlSize.width, this.vlSize.height);
  }

  private drawTranslucentOffscreenCtx(
    ctx: Context,
    offscreenCtx: Context,
    alpha: number) {

    ctx.save();
    ctx.globalAlpha = alpha;
    // Bring the canvas back to its original coordinates before
    // drawing the offscreen canvas contents.
    ctx.scale(1 / this.attrScale, 1 / this.attrScale);
    ctx.drawImage(offscreenCtx.canvas, 0, 0);
    ctx.restore();
  }

  // Draws any PathLayers to the canvas.
  private drawPaths(
    ctx: Context,
    extractDrawingCommandsFn: (layer: PathLayer) => ReadonlyArray<Command>,
  ) {
    this.vectorLayer.walk(layer => {
      if (layer instanceof ClipPathLayer) {
        // TODO: our SVG importer doesn't import clip paths... so this will never happen (yet)
        const transforms = getTransformsForLayer(this.vectorLayer, layer.id);
        executeCommands(ctx, layer.pathData.getCommands(), transforms);
        ctx.clip();
        return;
      }
      if (!(layer instanceof PathLayer)) {
        return;
      }
      const commands = extractDrawingCommandsFn(layer);
      if (!commands.length) {
        return;
      }

      ctx.save();

      const transforms = getTransformsForLayer(this.vectorLayer, layer.id);
      executeCommands(ctx, commands, transforms);

      // TODO: confirm this stroke multiplier thing works...
      const strokeWidthMultiplier = MathUtil.flattenTransforms(transforms).getScale();
      ctx.strokeStyle = ColorUtil.androidToCssColor(layer.strokeColor, layer.strokeAlpha);
      ctx.lineWidth = layer.strokeWidth * strokeWidthMultiplier;
      ctx.fillStyle = ColorUtil.androidToCssColor(layer.fillColor, layer.fillAlpha);
      ctx.lineCap = layer.strokeLinecap;
      ctx.lineJoin = layer.strokeLinejoin;
      ctx.miterLimit = layer.strokeMiterLimit;

      // TODO: update layer.pathData.length so that it reflects scale transforms
      if (layer.trimPathStart !== 0
        || layer.trimPathEnd !== 1
        || layer.trimPathOffset !== 0) {
        // Calculate the visible fraction of the trimmed path. If trimPathStart
        // is greater than trimPathEnd, then the result should be the combined
        // length of the two line segments: [trimPathStart,1] and [0,trimPathEnd].
        let shownFraction = layer.trimPathEnd - layer.trimPathStart;
        if (layer.trimPathStart > layer.trimPathEnd) {
          shownFraction += 1;
        }
        // Calculate the dash array. The first array element is the length of
        // the trimmed path and the second element is the gap, which is the
        // difference in length between the total path length and the visible
        // trimmed path length.
        ctx.setLineDash([
          shownFraction * layer.pathData.getPathLength(),
          (1 - shownFraction + 0.001) * layer.pathData.getPathLength()
        ]);
        // The amount to offset the path is equal to the trimPathStart plus
        // trimPathOffset. We mod the result because the trimmed path
        // should wrap around once it reaches 1.
        ctx.lineDashOffset = layer.pathData.getPathLength()
          * (1 - ((layer.trimPathStart + layer.trimPathOffset) % 1));
      } else {
        ctx.setLineDash([]);
      }
      if (layer.isStroked()
        && layer.strokeWidth
        && layer.trimPathStart !== layer.trimPathEnd) {
        ctx.stroke();
      }
      if (layer.isFilled()) {
        if (layer.fillType === 'evenOdd') {
          // Unlike VectorDrawables, SVGs spell 'evenodd' with a lowercase 'o'.
          ctx.fill('evenodd');
        } else {
          ctx.fill();
        }
      }
      ctx.restore();
    });
  }

  // Draw labeled points, highlights, selections, the pixel grid, etc.
  drawOverlays() {
    if (!this.isViewInit) {
      return;
    }
    this.overlayCtx.save();
    this.setupCtxWithViewportCoords(this.overlayCtx);
    if (this.shouldDrawLayers) {
      this.drawSplitSubPathHighlights(this.overlayCtx);
      this.drawHighlights(this.overlayCtx);
      this.drawHighlightedAddPointSegment(this.overlayCtx);
      this.drawHighlightedSplitShapeSegment(this.overlayCtx);
      this.drawLabeledPoints(this.overlayCtx);
      this.drawDraggingPoints(this.overlayCtx);
      this.drawAddPointPreview(this.overlayCtx);
      this.drawSplitShapePreview(this.overlayCtx);
    }
    this.overlayCtx.restore();

    // Note that the pixel grid is not drawn in viewport coordinates like above.
    if (this.cssScale > 4) {
      this.overlayCtx.save();
      this.overlayCtx.fillStyle = 'rgba(128, 128, 128, .25)';
      const devicePixelRatio = window.devicePixelRatio || 1;
      for (let x = 1; x < this.vlSize.width; x++) {
        this.overlayCtx.fillRect(
          x * this.attrScale - 0.5 * devicePixelRatio,
          0,
          devicePixelRatio,
          this.vlSize.height * this.attrScale);
      }
      for (let y = 1; y < this.vlSize.height; y++) {
        this.overlayCtx.fillRect(
          0,
          y * this.attrScale - 0.5 * devicePixelRatio,
          this.vlSize.width * this.attrScale,
          devicePixelRatio);
      }
      this.overlayCtx.restore();
    }
  }

  private drawSplitSubPathHighlights(ctx: Context) {
    if (this.canvasType === CanvasType.Preview || !this.activePathId) {
      return;
    }

    // TODO: make this more efficient by executing them in batches!!!
    // TODO: make this more efficient by executing them in batches!!!
    // TODO: make this more efficient by executing them in batches!!!
    // TODO: make this more efficient by executing them in batches!!!
    // TODO: make this more efficient by executing them in batches!!!
    const subPaths = this.activePath.getSubPaths()
      .filter(subPath => !subPath.isCollapsing());
    const transforms = this.transformsForActiveLayer;
    for (const subPath of subPaths) {
      const cmds = subPath.getCommands();
      for (let i = 0; i < cmds.length; i++) {
        const cmd = cmds[i];
        if (!cmd.isSubPathSplitSegment()) {
          continue;
        }
        executeCommands(ctx, [cmd], transforms);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = SPLIT_POINT_COLOR;
        ctx.lineWidth = this.highlightLineWidth / 3;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Draw any highlighted subpaths.
  private drawHighlights(ctx: Context) {
    if (this.canvasType === CanvasType.Preview
      || this.appMode !== AppMode.SelectPoints
      || !this.activePathId) {
      return;
    }

    const selectedSubIdxs: Set<number> = new Set<number>();
    if (this.currentHover) {
      selectedSubIdxs.add(this.currentHover.subIdx);
    }

    for (const sel of this.selectionService.getSelections()) {
      selectedSubIdxs.add(sel.subIdx);
    }

    const subPaths = Array.from(selectedSubIdxs)
      .map(subIdx => this.activePath.getSubPaths()[subIdx])
      .filter(subPath => !subPath.isCollapsing());

    const transforms = this.transformsForActiveLayer;
    for (const subPath of subPaths) {
      let highlightColor = HIGHLIGHT_COLOR;
      const cmds = subPath.getCommands();
      for (const cmd of cmds) {
        if (cmd.isSubPathSplitSegment()) {
          highlightColor = SPLIT_POINT_COLOR;
          break;
        }
      }
      executeCommands(ctx, cmds, transforms);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = highlightColor;
      ctx.lineWidth = this.highlightLineWidth / 2;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Draw any labeled points.
  private drawLabeledPoints(ctx: Context) {
    if (this.canvasType === CanvasType.Preview
      && !this.shouldLabelPoints
      || !this.activePathId) {
      return;
    }

    let path = this.activePath;
    if (this.currentHoverPreviewPath) {
      path = this.currentHoverPreviewPath;
    }

    interface PointInfo {
      cmd: Command;
      subIdx: number;
      cmdIdx: number;
    }

    const pathDataPointInfos: PointInfo[] =
      _.chain(path.getSubPaths() as SubPath[])
        .filter(subPath => !subPath.isCollapsing())
        .map((subPath, subIdx) => {
          return subPath.getCommands()
            .map((cmd, cmdIdx) => { return { cmd, subIdx, cmdIdx }; });
        })
        .flatMap(pointInfos => pointInfos)
        .reverse()
        .value();

    const currSelections = this.selectionService.getSelections().map(sel => {
      return { type: sel.type, subIdx: sel.subIdx, cmdIdx: sel.cmdIdx };
    });
    const selectedSubPathIndices = _.flatMap(currSelections, sel => {
      return sel.type === SelectionType.SubPath ? [sel.subIdx] : [];
    });

    const isPointInfoSelectedFn = (pointInfo: PointInfo) => {
      const { subIdx, cmdIdx } = pointInfo;
      const isSubPathSelected =
        selectedSubPathIndices.indexOf(subIdx) >= 0;
      if (isSubPathSelected) {
        return true;
      }
      return _.findIndex(currSelections, sel => {
        return sel.subIdx === subIdx;
      }) >= 0;
    };

    const removedSelectedCommands =
      _.remove(pathDataPointInfos, pointInfo => {
        const { subIdx, cmdIdx } = pointInfo;
        const isSubPathSelected =
          selectedSubPathIndices.indexOf(subIdx) >= 0;
        if (isSubPathSelected) {
          return true;
        }
        return _.findIndex(currSelections, sel => {
          return sel.subIdx === subIdx
            && sel.cmdIdx === cmdIdx;
        }) >= 0;
      });
    pathDataPointInfos.push(
      ..._.remove(pathDataPointInfos, pointInfo => {
        return isPointInfoSelectedFn(pointInfo);
      }));
    pathDataPointInfos.push(...removedSelectedCommands);

    const isPointInfoHoveringFn = (pointInfo: PointInfo) => {
      const hover = this.currentHover;
      return hover && pointInfo.subIdx === hover.subIdx;
    };

    const removedHoverCommands =
      _.remove(pathDataPointInfos, pointInfo => {
        const hover = this.currentHover;
        return hover
          && hover.type === HoverType.Point
          && pointInfo.subIdx === hover.subIdx
          && pointInfo.cmdIdx === hover.cmdIdx;
      });
    pathDataPointInfos.push(
      ..._.remove(pathDataPointInfos, pointInfo => {
        return isPointInfoHoveringFn(pointInfo);
      }));
    pathDataPointInfos.push(...removedHoverCommands);

    const draggedCommandIndex =
      this.pathSelector
        && this.pathSelector.isDragTriggered()
        ? this.pathSelector.getDraggableSplitIndex()
        : undefined;
    const transforms = this.transformsForActiveLayer.reverse();
    for (const pointInfo of pathDataPointInfos) {
      const { cmd, subIdx, cmdIdx } = pointInfo;
      if (draggedCommandIndex
        && subIdx === draggedCommandIndex.subIdx
        && cmdIdx === draggedCommandIndex.cmdIdx) {
        // Skip the currently dragged point. We'll draw that next.
        continue;
      }
      let radius = this.smallPointRadius;
      let text: string = undefined;
      if (isPointInfoHoveringFn(pointInfo) || isPointInfoSelectedFn(pointInfo)) {
        radius = this.mediumPointRadius * SELECTED_POINT_RADIUS_FACTOR;
        if ((isPointInfoHoveringFn(pointInfo)
          && pointInfo.cmdIdx === this.currentHover.cmdIdx)
          || this.selectionService.isCommandSelected(pointInfo.subIdx, pointInfo.cmdIdx)) {
          radius *= (1 / SPLIT_POINT_RADIUS_FACTOR);
        }
        text = (cmdIdx + 1).toString();
      }
      if (pointInfo.cmd.isSplit()) {
        radius *= SPLIT_POINT_RADIUS_FACTOR;
      }
      const point = MathUtil.transformPoint(_.last(cmd.getPoints()), ...transforms);
      const color = cmd.isSplit() ? SPLIT_POINT_COLOR : NORMAL_POINT_COLOR;
      this.drawLabeledPoint(ctx, point, radius, color, text);
    }
  }

  // Draw any actively dragged points along the path (selection mode only).
  private drawDraggingPoints(ctx: Context) {
    if (this.appMode !== AppMode.SelectPoints
      || !this.pathSelector
      || !this.pathSelector.isDragTriggered()) {
      return;
    }
    let point;
    const projection = this.pathSelector.getProjectionOntoPath().projection;
    if (projection && projection.d < this.minSnapThreshold) {
      point = this.pathPointToDrawingCoords(new Point(projection.x, projection.y));
    } else {
      point = this.pathSelector.getLastKnownMouseLocation();
    }
    this.drawLabeledPoint(
      ctx, point, this.mediumPointRadius * SPLIT_POINT_RADIUS_FACTOR, SPLIT_POINT_COLOR);
  }

  private drawHighlightedAddPointSegment(ctx: Context) {
    if (this.appMode !== AppMode.AddPoints
      || !this.segmentSplitter
      || !this.segmentSplitter.getLastKnownMouseLocation()) {
      return;
    }
    const projectionOntoPath = this.segmentSplitter.getProjectionOntoPath();
    if (!projectionOntoPath) {
      return;
    }
    const transforms = this.transformsForActiveLayer;
    const projection = projectionOntoPath.projection;
    if (projection.d < this.minSnapThreshold) {
      const { subIdx, cmdIdx } = projectionOntoPath;
      executeCommands(ctx, [this.activePath.getCommand(subIdx, cmdIdx)], transforms);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = SPLIT_POINT_COLOR;
      ctx.lineWidth = this.highlightLineWidth / 2;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.restore();
    } else {
      executeCommands(ctx, this.activePath.getCommands(), transforms);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = SPLIT_POINT_COLOR;
      ctx.lineWidth = this.highlightLineWidth / 1.3;
      ctx.setLineDash([this.lineDashLength / 1.5, this.lineDashLength / 1.5]);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawAddPointPreview(ctx: Context) {
    if (this.appMode !== AppMode.AddPoints || !this.segmentSplitter) {
      return;
    }
    let point;
    const projectionOntoPath = this.segmentSplitter.getProjectionOntoPath();
    if (projectionOntoPath) {
      const projection = projectionOntoPath.projection;
      if (projection && projection.d < this.minSnapThreshold) {
        point = this.pathPointToDrawingCoords(new Point(projection.x, projection.y));
      }
    }
    if (point) {
      this.drawLabeledPoint(
        ctx, point, this.mediumPointRadius * SPLIT_POINT_RADIUS_FACTOR, SPLIT_POINT_COLOR);
    }
  }

  private drawHighlightedSplitShapeSegment(ctx: Context) {
    if (this.appMode !== AppMode.SplitSubPaths || !this.shapeSplitter) {
      return;
    }
    const proj1 = this.shapeSplitter.getInitialProjectionOntoPath();
    if (proj1) {
      const proj2 = this.shapeSplitter.getFinalProjectionOntoPath();
      const startPoint =
        this.pathPointToDrawingCoords(new Point(proj1.projection.x, proj1.projection.y));
      let endPoint: Point;
      if (proj2) {
        endPoint = this.pathPointToDrawingCoords(new Point(proj2.projection.x, proj2.projection.y));
      } else {
        endPoint = this.shapeSplitter.getLastKnownMouseLocation();
      }

      const subPathCmds = this.activePath.getSubPath(proj1.subIdx).getCommands();
      const transforms = this.transformsForActiveLayer;

      executeCommands(ctx, subPathCmds, transforms);

      ctx.save();
      transforms.forEach(m => ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f));
      ctx.beginPath();
      ctx.moveTo(startPoint.x, startPoint.y);
      ctx.lineTo(endPoint.x, endPoint.y);
      ctx.lineCap = 'round';
      ctx.strokeStyle = SPLIT_POINT_COLOR;
      ctx.lineWidth = this.highlightLineWidth / 2;
      ctx.stroke();
      ctx.restore();
    } else {
      let point;
      const projectionOntoPath = this.shapeSplitter.getCurrentProjectionOntoPath();
      if (projectionOntoPath) {
        const projection = projectionOntoPath.projection;
        if (projection && projection.d < this.minSnapThreshold) {
          point = this.pathPointToDrawingCoords(new Point(projection.x, projection.y));
        }
      }
      if (point) {
        const { subIdx, cmdIdx } = projectionOntoPath;
        const command = this.activePath.getCommand(subIdx, cmdIdx);
        const transforms = this.transformsForActiveLayer;
        executeCommands(ctx, [command], transforms);

        const lineWidth = this.highlightLineWidth;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = SPLIT_POINT_COLOR;
        ctx.lineWidth = lineWidth / 2;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawSplitShapePreview(ctx: Context) {
    if (this.appMode !== AppMode.SplitSubPaths || !this.shapeSplitter) {
      return;
    }
    const proj1 = this.shapeSplitter.getInitialProjectionOntoPath();
    if (proj1) {
      const proj2 = this.shapeSplitter.getFinalProjectionOntoPath();
      const startPoint =
        this.pathPointToDrawingCoords(new Point(proj1.projection.x, proj1.projection.y));
      let endPoint: Point;
      if (proj2) {
        endPoint = this.pathPointToDrawingCoords(new Point(proj2.projection.x, proj2.projection.y));
      } else {
        endPoint = this.shapeSplitter.getLastKnownMouseLocation();
      }
      this.drawLabeledPoint(
        ctx, startPoint, this.mediumPointRadius * SPLIT_POINT_RADIUS_FACTOR, SPLIT_POINT_COLOR);
      if (this.shapeSplitter.willFinalProjectionOntoPathCreateSplitPoint()) {
        this.drawLabeledPoint(
          ctx, endPoint, this.mediumPointRadius * SPLIT_POINT_RADIUS_FACTOR, SPLIT_POINT_COLOR);
      }
    } else {
      let point;
      const projectionOntoPath = this.shapeSplitter.getCurrentProjectionOntoPath();
      if (projectionOntoPath) {
        const projection = projectionOntoPath.projection;
        if (projection && projection.d < this.minSnapThreshold) {
          point = this.pathPointToDrawingCoords(new Point(projection.x, projection.y));
        }
      }
      if (point) {
        this.drawLabeledPoint(
          ctx, point, this.mediumPointRadius * SPLIT_POINT_RADIUS_FACTOR, SPLIT_POINT_COLOR);
      }
    }
  }

  // Draws a labeled point with optional text.
  private drawLabeledPoint(ctx: Context, point: Point, radius: number, color: string, text?: string) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius * POINT_BORDER_FACTOR, 0, 2 * Math.PI, false);
    ctx.fillStyle = POINT_BORDER_COLOR;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = color;
    ctx.fill();

    if (text) {
      ctx.beginPath();
      ctx.fillStyle = POINT_TEXT_COLOR;
      ctx.font = radius + 'px Roboto, Helvetica Neue, sans-serif';
      const width = ctx.measureText(text).width;
      // TODO: is there a better way to get the height?
      const height = ctx.measureText('o').width;
      ctx.fillText(text, point.x - width / 2, point.y + height / 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // MOUSE DOWN
  onMouseDown(event: MouseEvent) {
    this.showRuler(event);
    if (!this.shouldProcessMouseEvents) {
      return;
    }
    const mouseDown = this.mouseEventToPoint(event);
    if (this.appMode === AppMode.SelectPoints) {
      this.pathSelector.onMouseDown(mouseDown, event.shiftKey || event.metaKey);
    } else if (this.appMode === AppMode.AddPoints) {
      this.segmentSplitter.onMouseDown(mouseDown);
    } else if (this.appMode === AppMode.SplitSubPaths) {
      if (this.activePathLayer.isStroked()) {
        this.segmentSplitter.onMouseDown(mouseDown);
      } else {
        this.shapeSplitter.onMouseDown(mouseDown);
      }
    }
  }

  // MOUSE MOVE
  onMouseMove(event: MouseEvent) {
    this.showRuler(event);
    if (!this.shouldProcessMouseEvents) {
      return;
    }
    const mouseMove = this.mouseEventToPoint(event);
    if (this.appMode === AppMode.SelectPoints) {
      this.pathSelector.onMouseMove(mouseMove);
    } else if (this.appMode === AppMode.AddPoints) {
      this.segmentSplitter.onMouseMove(mouseMove);
    } else if (this.appMode === AppMode.SplitSubPaths) {
      if (this.activePathLayer.isStroked()) {
        this.segmentSplitter.onMouseMove(mouseMove);
      } else {
        this.shapeSplitter.onMouseMove(mouseMove);
      }
    }
  }

  // MOUSE UP
  onMouseUp(event: MouseEvent) {
    this.showRuler(event);
    if (!this.shouldProcessMouseEvents) {
      return;
    }
    const mouseUp = this.mouseEventToPoint(event);
    if (this.appMode === AppMode.SelectPoints) {
      this.pathSelector.onMouseUp(mouseUp);
    } else if (this.appMode === AppMode.AddPoints) {
      this.segmentSplitter.onMouseUp(mouseUp);
    } else if (this.appMode === AppMode.SplitSubPaths) {
      if (this.activePathLayer.isStroked()) {
        this.segmentSplitter.onMouseUp(mouseUp);
      } else {
        this.shapeSplitter.onMouseUp(mouseUp);
      }
    }
  }

  onMouseLeave(event: MouseEvent) {
    this.canvasRulers.forEach(r => r.hideMouse());
    if (!this.shouldProcessMouseEvents) {
      return;
    }
    const mouseLeave = this.mouseEventToPoint(event);
    if (this.appMode === AppMode.SelectPoints) {
      // TODO: how to handle the case where the mouse leaves and re-enters mid-gesture?
      this.pathSelector.onMouseLeave(mouseLeave);
    } else if (this.appMode === AppMode.AddPoints) {
      this.segmentSplitter.onMouseLeave(mouseLeave);
    } else if (this.appMode === AppMode.SplitSubPaths) {
      if (this.activePathLayer.isStroked()) {
        this.segmentSplitter.onMouseLeave(mouseLeave);
      } else {
        this.shapeSplitter.onMouseLeave(mouseLeave);
      }
    }
  }

  onDoubleClick(event: MouseEvent) {
    this.canvasRulers.forEach(r => r.hideMouse());
    if (!this.shouldProcessMouseEvents) {
      return;
    }
    const mouseEvent = this.mouseEventToPoint(event);
    if (this.appMode === AppMode.SelectPoints) {
      const noSegments = !this.activePathLayer.isStroked();
      const hitResult = this.performHitTest(mouseEvent, { noSegments });
      if (hitResult.isHit) {
        const hits =
          [].concat(hitResult.segmentHits, hitResult.shapeHits, hitResult.endPointHits);
        const { subIdx } = _.last(hits);
        this.selectionService.setSelections([{
          subIdx,
          source: this.canvasType,
          type: SelectionType.SubPath,
        }]);
        this.appModeService.setAppMode(AppMode.AddPoints);
        this.drawOverlays();
      }
    }
  }

  /**
   * Sends a signal that the canvas rulers should be redrawn.
   */
  private showRuler(event: MouseEvent) {
    const canvasOffset = this.canvasContainer.offset();
    const x = (event.pageX - canvasOffset.left) / Math.max(1, this.cssScale);
    const y = (event.pageY - canvasOffset.top) / Math.max(1, this.cssScale);
    this.canvasRulers.forEach(r => r.showMouse(new Point(_.round(x), _.round(y))));
  }

  /**
   * Converts a mouse point's CSS coordinates into vector layer viewport coordinates.
   */
  private mouseEventToPoint(event: MouseEvent) {
    const canvasOffset = this.canvasContainer.offset();
    const x = (event.pageX - canvasOffset.left) / this.cssScale;
    const y = (event.pageY - canvasOffset.top) / this.cssScale;
    return new Point(x, y);
  }
}

/**
 * Returns a list of parent transforms for the specified layer ID. The transforms
 * are returned in top-down order (i.e. the transform for the layer's
 * immediate parent will be the very last matrix in the returned list). This
 * function returns undefined if the layer is not found in the vector layer.
 */
function getTransformsForLayer(vectorLayer: VectorLayer, layerId: string) {
  const getTransformsFn = (parents: Layer[], current: Layer): Matrix[] => {
    if (current.id === layerId) {
      return _.flatMap(parents, layer => {
        if (!(layer instanceof GroupLayer)) {
          return [];
        }
        return [
          Matrix.fromTranslation(layer.pivotX, layer.pivotY),
          Matrix.fromTranslation(layer.translateX, layer.translateY),
          Matrix.fromRotation(layer.rotation),
          Matrix.fromScaling(layer.scaleX, layer.scaleY),
          Matrix.fromTranslation(-layer.pivotX, -layer.pivotY),
        ];
      });
    }
    if (current.children) {
      for (const child of current.children) {
        const transforms = getTransformsFn(parents.concat([current]), child);
        if (transforms) {
          return transforms;
        }
      }
    }
    return undefined;
  };
  return getTransformsFn([], vectorLayer);
}

// Note that this function currently only supports contiguous sequences of commands.
function executeCommands(
  ctx: Context,
  commands: ReadonlyArray<Command>,
  transforms: Matrix[]) {

  ctx.save();
  transforms.forEach(m => ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f));
  ctx.beginPath();

  if (commands.length === 1 && commands[0].getSvgChar() !== 'M') {
    // Special handling for the case where we only want to draw
    // a single segment of the path.
    ctx.moveTo(commands[0].getStart().x, commands[0].getStart().y);
  }

  let previousEndPoint: Point;
  commands.forEach(cmd => {
    const start = cmd.getStart();
    const end = cmd.getEnd();
    if (cmd.getSvgChar() === 'M') {
      ctx.moveTo(end.x, end.y);
    } else if (cmd.getSvgChar() === 'L') {
      ctx.lineTo(end.x, end.y);
    } else if (cmd.getSvgChar() === 'Q') {
      ctx.quadraticCurveTo(
        cmd.getPoints()[1].x, cmd.getPoints()[1].y,
        cmd.getPoints()[2].x, cmd.getPoints()[2].y);
    } else if (cmd.getSvgChar() === 'C') {
      ctx.bezierCurveTo(
        cmd.getPoints()[1].x, cmd.getPoints()[1].y,
        cmd.getPoints()[2].x, cmd.getPoints()[2].y,
        cmd.getPoints()[3].x, cmd.getPoints()[3].y);
    } else if (cmd.getSvgChar() === 'Z') {
      if (start.equals(previousEndPoint)) {
        ctx.closePath();
      } else {
        // This is mainly to support the case where the list of commands
        // is size one and contains only a closepath command.
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
      }
    }
    previousEndPoint = end;
  });
  ctx.restore();
}

interface HitTestOpts {
  noPoints?: boolean;
  noSegments?: boolean;
  noShapes?: boolean;
  restrictToSubIdx?: number[];
}
