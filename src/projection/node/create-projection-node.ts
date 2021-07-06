import sync, { cancelSync, flushSync } from "framesync"
import { mix } from "popmotion"
import { animate, AnimationPlaybackControls } from "../../animation/animate"
import { ResolvedValues } from "../../render/types"
import { Transition } from "../../types"
import { SubscriptionManager } from "../../utils/subscription-manager"
import { mixValues } from "../animation/mix-values"
import { copyBoxInto } from "../geometry/copy"
import { applyBoxDelta, applyTreeDeltas } from "../geometry/delta-apply"
import { calcBoxDelta, calcLength } from "../geometry/delta-calc"
import { removeBoxTransforms } from "../geometry/delta-remove"
import { createBox, createDelta } from "../geometry/models"
import { transformBox, translateAxis } from "../geometry/operations"
import { AxisDelta, Box, Delta, Point } from "../geometry/types"
import { getValueTransition } from "../../animation/utils/transitions"
import { isDeltaZero } from "../geometry/utils"
import { NodeStack } from "../shared/stack"
import { scaleCorrectors } from "../styles/scale-correction"
import { buildProjectionTransform } from "../styles/transform"
import { eachAxis } from "../utils/each-axis"
import { hasScale, hasTransform } from "../utils/has-transform"
import {
    IProjectionNode,
    LayoutUpdateData,
    LayoutUpdateHandler,
    ProjectionNodeConfig,
    ProjectionNodeOptions,
    Snapshot,
} from "./types"

export function createProjectionNode<I>({
    attachResizeListener,
    defaultParent,
    measureScroll,
    measureViewportBox,
    resetTransform,
}: ProjectionNodeConfig<I>) {
    return class ProjectionNode implements IProjectionNode<I> {
        id: number

        instance: I

        root: IProjectionNode

        parent?: IProjectionNode

        path: IProjectionNode[]

        children = new Set<IProjectionNode>()

        options: ProjectionNodeOptions = {}

        snapshot: Snapshot | undefined

        layout: Box | undefined

        layoutCorrected: Box

        scroll?: Point

        isLayoutDirty = false

        isUpdating = false

        shouldResetTransform = false

        treeScale: Point = { x: 1, y: 1 } // TODO Lazy-initialise

        targetDelta?: Delta

        projectionDelta?: Delta
        projectionDeltaWithTransform?: Delta

        lead?: IProjectionNode
        target?: Box
        targetWithTransforms?: Box

        latestValues: ResolvedValues

        layoutWillUpdateListeners?: SubscriptionManager<VoidFunction>
        layoutDidUpdateListeners?: SubscriptionManager<LayoutUpdateHandler>

        constructor(
            id: number,
            latestValues: ResolvedValues,
            parent: IProjectionNode | undefined = defaultParent?.()
        ) {
            this.id = id
            this.latestValues = latestValues
            this.root = parent ? parent.root || parent : this
            this.path = parent ? [...parent.path, parent] : []
            this.parent = parent

            this.root.registerPotentialNode(id, this)
        }

        // Note: Currently only running on root node
        potentialNodes = new Map<number, IProjectionNode>()
        registerPotentialNode(id: number, node: IProjectionNode) {
            this.potentialNodes.set(id, node)
        }

        /**
         * Lifecycles
         */
        mount(instance: I, isLayoutDirty = false) {
            if (this.instance) return
            this.instance = instance
            this.parent?.children.add(this)
            this.root.potentialNodes.delete(this.id)

            if (isLayoutDirty) {
                this.isLayoutDirty = true
                this.setTargetDelta(createDelta())
            }

            attachResizeListener?.(instance, () => {
                // TODO: Complete all active animations/delete all projections
            })

            const { layoutId, layout, visualElement } = this.options
            if (layoutId) {
                this.root.registerSharedNode(layoutId, this)
            }

            // Only register the handler if it requires layout animation
            if (visualElement && (layoutId || layout)) {
                this.onLayoutDidUpdate(
                    ({ delta, hasLayoutChanged, snapshot }) => {
                        // TODO: Check here if an animation exists
                        const layoutTransition =
                            visualElement.getDefaultTransition() ||
                            defaultLayoutTransition

                        const {
                            onLayoutAnimationComplete,
                        } = visualElement.getProps()

                        if (
                            hasLayoutChanged
                            /**
                             * Don't create a new animation if the target box
                             * hasn't changed TODO: And we're already animating
                             */
                            // !boxEquals(layoutTarget.current, newLayout)
                        ) {
                            // TODO: On final frame, delete delta
                            this.setAnimationOrigin(
                                delta,
                                snapshot.latestValues
                            )
                            this.startAnimation({
                                ...getValueTransition(
                                    layoutTransition,
                                    "layout"
                                ),
                                onComplete: onLayoutAnimationComplete,
                            })
                        }
                    }
                )
            }
        }

        unmount() {
            // @TODO: only snapshot if there's a pending lead sharing the same layout id
            if (this.options.layoutId) {
                this.willUpdate()
            }
            this.getStack()?.remove(this)
            this.parent?.children.delete(this)
            cancelSync.preRender(this.updateProjection)
        }

        // Note: currently only running on root node
        startUpdate() {
            this.isUpdating = true

            // TODO: Traverse the tree, reset rotations
        }

        willUpdate(shouldNotifyListeners = true) {
            !this.root.isUpdating && this.root.startUpdate()
            if (!this.isLead() || this.isLayoutDirty) return

            this.isLayoutDirty = true

            this.path.forEach((node) => {
                node.shouldResetTransform = true

                /**
                 * TODO: Check we haven't updated the scroll
                 * since the last didUpdate
                 */
                node.updateScroll()
            })

            this.updateSnapshot()
            shouldNotifyListeners && this.layoutWillUpdateListeners?.notify()
        }

        // Note: Currently only running on root node
        didUpdate() {
            if (!this.isUpdating) return

            this.potentialNodes.forEach((node, id) => {
                const element = document.querySelector(
                    `[data-projection-id="${id}"]`
                )
                if (element) node.mount(element, true)
                console.log(!!element, id)
            })
            this.potentialNodes.clear()

            /**
             * Write
             */
            resetTreeTransform(this)

            /**
             * Read ==================
             */
            // Update layout measurements of updated children
            updateTreeLayout(this)

            /**
             * Write
             */
            // Notify listeners that the layout is updated
            notifyLayoutUpdate(this)

            // Flush any scheduled updates
            flushSync.update()
            flushSync.preRender()
            flushSync.render()

            this.isUpdating = false
        }

        scheduleUpdateProjection() {
            sync.preRender(this.updateProjection, false, true)
        }

        updateProjection = () => {
            updateProjectionTree(this)
        }

        /**
         * Update measurements
         */
        updateSnapshot() {
            if (this.snapshot) return

            const visible = this.removeTransform(this.measure()!)
            this.snapshot = {
                visible,
                layout: this.removeElementScroll(visible!),
            }
        }

        updateLayout() {
            // TODO: Incorporate into a forwarded
            // scroll offset
            if (this.options.shouldMeasureScroll) {
                this.updateScroll()
            }

            if (!this.isLayoutDirty) return

            this.layout = this.removeElementScroll(this.measure())

            this.layoutCorrected = createBox()
            this.isLayoutDirty = false
        }

        updateScroll() {
            if (!measureScroll) return
            this.scroll = measureScroll(this.instance)
        }

        resetTransform() {
            if (
                resetTransform &&
                (this.isLayoutDirty || this.shouldResetTransform) &&
                ((this.projectionDelta && !isDeltaZero(this.projectionDelta)) ||
                    hasTransform(this.latestValues))
            ) {
                resetTransform(this.instance)
                this.shouldResetTransform = false
                this.options.onProjectionUpdate?.()
            }
        }

        measure() {
            if (!measureViewportBox) return createBox()

            const box = measureViewportBox(this.instance)

            // Remove window scroll to give page-relative coordinates
            const { scroll } = this.root
            // TODO Make loop
            scroll && eachAxis((axis) => translateAxis(box[axis], scroll[axis]))

            return box
        }

        removeElementScroll(box: Box): Box {
            const boxWithoutScroll = createBox()
            copyBoxInto(boxWithoutScroll, box)

            /**
             * Performance TODO: Keep a cumulative scroll offset down the tree
             * rather than loop back up the path.
             */
            for (let i = 0; i < this.path.length; i++) {
                const node = this.path[i]
                const { scroll, options } = node
                if (
                    node !== this.root &&
                    scroll &&
                    options.shouldMeasureScroll
                ) {
                    translateAxis(boxWithoutScroll.x, scroll.x)
                    translateAxis(boxWithoutScroll.y, scroll.y)
                }
            }

            return boxWithoutScroll
        }

        removeTransform(box: Box): Box {
            const boxWithoutTransform = createBox()
            copyBoxInto(boxWithoutTransform, box)

            for (let i = 0; i < this.path.length; i++) {
                const node = this.path[i]
                if (!hasTransform(node.latestValues)) continue

                hasScale(node.latestValues) && node.updateSnapshot()

                removeBoxTransforms(
                    boxWithoutTransform,
                    node.latestValues,
                    node.snapshot!.layout
                )
            }

            removeBoxTransforms(boxWithoutTransform, this.latestValues)

            return boxWithoutTransform
        }

        /**
         *
         */
        setTargetDelta(delta: Delta) {
            this.targetDelta = delta
            this.root.scheduleUpdateProjection()
        }

        setOptions(options: ProjectionNodeOptions) {
            this.options = options
        }

        /**
         * Frame calculations
         */
        resolveTargetDelta() {
            if (!this.targetDelta || !this.layout) return

            if (!this.target) {
                this.target = createBox()
                this.targetWithTransforms = createBox()
            }

            copyBoxInto(this.target, this.layout)
            applyBoxDelta(this.target, this.targetDelta)
        }

        calcProjection() {
            const { target } = this.getLead()

            if (!this.layout || !target) return

            if (!this.projectionDelta) {
                this.projectionDelta = createDelta()
                this.projectionDeltaWithTransform = createDelta()
            }

            /**
             * Reset the corrected box with the latest values from box, as we're then going
             * to perform mutative operations on it.
             */
            copyBoxInto(this.layoutCorrected, this.layout)

            /**
             * Apply all the parent deltas to this box to produce the corrected box. This
             * is the layout box, as it will appear on screen as a result of the transforms of its parents.
             */
            applyTreeDeltas(this.layoutCorrected, this.treeScale, this.path)

            /**
             * Update the delta between the corrected box and the target box before user-set transforms were applied.
             * This will allow us to calculate the corrected borderRadius and boxShadow to compensate
             * for our layout reprojection, but still allow them to be scaled correctly by the user.
             * It might be that to simplify this we may want to accept that user-set scale is also corrected
             * and we wouldn't have to keep and calc both deltas, OR we could support a user setting
             * to allow people to choose whether these styles are corrected based on just the
             * layout reprojection or the final bounding box.
             */
            calcBoxDelta(
                this.projectionDelta,
                this.layoutCorrected,
                target,
                this.latestValues
            )

            // TODO Make this event listener
            const { onProjectionUpdate } = this.options
            onProjectionUpdate && onProjectionUpdate()
        }

        isVisible = true
        hide() {
            this.isVisible = false
            // TODO: Schedule render
        }
        show() {
            this.isVisible = true
            // TODO: Schedule render
        }

        scheduleRender() {
            // TODO Rename this option
            this.options.onProjectionUpdate?.()
        }

        /**
         * Animation
         */
        animationProgress = 0
        animationValues?: ResolvedValues
        currentAnimation: AnimationPlaybackControls
        mixTargetDelta: (progress: number) => void

        setAnimationOrigin(delta: Delta, latestValues: ResolvedValues) {
            this.animationValues = {}
            const targetDelta = createDelta()
            let shouldCrossfadeOpacity =
                this.options.crossfade === true &&
                !this.path.some(hasOpacityCrossfade)

            this.mixTargetDelta = (latest: number) => {
                const progress = latest / 1000
                mixAxisDelta(targetDelta.x, delta.x, progress)
                mixAxisDelta(targetDelta.y, delta.y, progress)

                if (latestValues !== this.latestValues) {
                    mixValues(
                        this.animationValues,
                        latestValues,
                        this.latestValues,
                        progress,
                        shouldCrossfadeOpacity
                    )
                }

                this.setTargetDelta(targetDelta)
                this.root.scheduleUpdateProjection()
            }
            this.mixTargetDelta(0)
        }

        startAnimation(transition: Transition) {
            this.currentAnimation?.stop()
            this.currentAnimation = animate(0, 1000, {
                ...(transition as any),
                onUpdate: this.mixTargetDelta,
                onComplete: () => {
                    this.animationValues = undefined
                },
            })
        }

        applyTransformsToTarget() {
            const {
                targetWithTransforms,
                target,
                latestValues,
            } = this.getLead()
            console.log("apply", targetWithTransforms, target, latestValues)
            copyBoxInto(targetWithTransforms!, target!)

            /**
             * Apply the latest user-set transforms to the targetBox to produce the targetBoxFinal.
             * This is the final box that we will then project into by calculating a transform delta and
             * applying it to the corrected box.
             */
            transformBox(targetWithTransforms!, latestValues)

            /**
             * Update the delta between the corrected box and the final target box, after
             * user-set transforms are applied to it. This will be used by the renderer to
             * create a transform style that will reproject the element from its actual layout
             * into the desired bounding box.
             */
            calcBoxDelta(
                this.projectionDeltaWithTransform!,
                this.layoutCorrected,
                targetWithTransforms!,
                latestValues
            )
        }

        /**
         * Events
         *
         * TODO Replace this with a key-based lookup
         */
        onLayoutWillUpdate(handler: VoidFunction) {
            if (!this.layoutWillUpdateListeners) {
                this.layoutWillUpdateListeners = new SubscriptionManager()
            }
            return this.layoutWillUpdateListeners!.add(handler)
        }

        onLayoutDidUpdate(handler: (data: LayoutUpdateData) => void) {
            if (!this.layoutDidUpdateListeners) {
                this.layoutDidUpdateListeners = new SubscriptionManager()
            }
            return this.layoutDidUpdateListeners!.add(handler)
        }

        /**
         * Shared layout
         */
        // TODO Only running on root node
        sharedNodes: Map<string, NodeStack> = new Map()
        registerSharedNode(layoutId: string, node: IProjectionNode) {
            if (!this.sharedNodes.has(layoutId)) {
                this.sharedNodes.set(layoutId, new NodeStack())
            }

            const stack = this.sharedNodes.get(layoutId)!
            stack.add(node)
        }

        isLead() {
            const stack = this.getStack()
            return stack ? stack.lead === this : true
        }

        getLead() {
            const { layoutId } = this.options
            return layoutId ? this.getStack()?.lead || this : this
        }

        getStack() {
            const { layoutId } = this.options
            if (layoutId) return this.root.sharedNodes.get(layoutId)
        }

        promote() {
            const stack = this.getStack()
            if (stack) stack.promote(this)
        }

        getProjectionStyles() {
            // TODO: Return lifecycle-persistent object
            const styles: ResolvedValues = {}

            if (!this.isVisible) {
                return { visibility: "hidden" }
            }

            if (!this.projectionDelta) {
                return emptyStyles
            }

            // TODO: Return persistent mutable object

            this.applyTransformsToTarget()
            styles.transform = buildProjectionTransform(
                this.projectionDeltaWithTransform!,
                this.treeScale,
                this.latestValues
            )

            const lead = this.getLead()
            const valuesToRender = lead.animationValues || lead.latestValues

            // TODO Move into stand-alone, testable function
            const { x, y } = this.projectionDelta
            styles.transformOrigin = `${x.origin * 100}% ${y.origin * 100}% 0`

            styles.opacity =
                lead === this
                    ? valuesToRender.opacity
                    : valuesToRender.opacityExit

            /**
             * Apply scale correction
             */
            for (const key in scaleCorrectors) {
                if (valuesToRender[key] === undefined) {
                    continue
                }

                const { correct, applyTo } = scaleCorrectors[key]
                const corrected = correct(valuesToRender[key], lead)

                if (applyTo) {
                    const num = applyTo.length
                    for (let i = 0; i < num; i++) {
                        styles[applyTo[i]] = corrected
                    }
                } else {
                    styles[key] = corrected
                }
            }
            console.log({ styles })
            return styles
        }
    }
}

const emptyStyles = {}

function updateTreeLayout(node: IProjectionNode) {
    node.updateLayout()
    node.children.forEach(updateTreeLayout)
}

function notifyLayoutUpdate(node: IProjectionNode) {
    const { layout, snapshot } = node

    if (node.isLead() && layout && snapshot && node.layoutDidUpdateListeners) {
        // TODO Maybe we want to also resize the layout snapshot so we don't trigger
        // animations for instance if layout="size" and an element has only changed position
        if (node.options.animationType === "size") {
            eachAxis((axis) => {
                const axisSnapshot = snapshot.visible[axis]
                const length = calcLength(axisSnapshot)
                axisSnapshot.min = layout[axis].min
                axisSnapshot.max = axisSnapshot.min + length
            })
        } else if (node.options.animationType === "position") {
            eachAxis((axis) => {
                const axisSnapshot = snapshot.visible[axis]
                const length = calcLength(layout[axis])
                axisSnapshot.max = axisSnapshot.min + length
            })
        }

        const layoutDelta = createDelta()
        calcBoxDelta(layoutDelta, layout, snapshot.layout)
        const visualDelta = createDelta()
        calcBoxDelta(visualDelta, layout, snapshot.visible)

        node.layoutDidUpdateListeners.notify({
            layout,
            snapshot,
            delta: visualDelta,
            hasLayoutChanged: !isDeltaZero(layoutDelta),
        })
    }

    node.children.forEach(notifyLayoutUpdate)
    console.log("node.children", node.children.size)

    node.snapshot = undefined
    console.log("snapshot deleted", node.instance.id)
}

function resetTreeTransform(node: IProjectionNode) {
    node.resetTransform()
    node.children.forEach(resetTreeTransform)
}

function updateProjectionTree(node: IProjectionNode) {
    resolveTreeTargetDeltas(node)
    calcTreeProjection(node)
}

function resolveTreeTargetDeltas(node: IProjectionNode) {
    node.resolveTargetDelta()
    node.children.forEach(resolveTreeTargetDeltas)
}

function calcTreeProjection(node: IProjectionNode) {
    node.calcProjection()
    node.children.forEach(calcTreeProjection)
}

export function mixAxisDelta(output: AxisDelta, delta: AxisDelta, p: number) {
    output.translate = mix(delta.translate, 0, p)
    output.scale = mix(delta.scale, 1, p)
    output.origin = delta.origin
    output.originPoint = delta.originPoint
}

function hasOpacityCrossfade(node: IProjectionNode) {
    return (
        node.animationValues && node.animationValues.opacityExit !== undefined
    )
}

const defaultLayoutTransition = {
    duration: 0.45,
    ease: [0.4, 0, 0.1, 1],
}